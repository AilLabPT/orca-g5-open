# Ephemeral CI only: one private-sshd account, DefaultShell and vitest process per host cell for an empty runtime store.
param(
 [Parameter(Mandatory=$true)][string]$SourceRoot,
 [Parameter(Mandatory=$true)][hashtable]$Context,
 [Parameter(Mandatory=$true)][ValidateSet('win32-arm64','win32-x64')][string]$Target,
 [Parameter(Mandatory=$true)][string]$ReceiptRoot,
 [ValidateSet('orcad-cmd','orcad-powershell','orcad-convert','orcad-cli-managed','orcad-cli-convert')][string[]]$Cells=@('orcad-cmd','orcad-powershell')
)
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -ne 'true' -or $env:ORCA_ISOLATED_SSH_CI -ne '1'){throw 'Disposable CI only'}
$shells=@{'orcad-cmd'='cmd';'orcad-powershell'='powershell';'orcad-convert'='cmd';'orcad-cli-managed'='cmd';'orcad-cli-convert'='cmd'}
# App-level cells drive the e2e build (and the bundled CLI) against the host; each greps one tagged test.
$appCells=@{'orcad-convert'=@('tests/e2e/ssh-orcad-auto-convert.spec.ts','');'orcad-cli-managed'=@('tests/e2e/ssh-orcad-windows-cli-matrix.spec.ts','@orcad-cli-managed');'orcad-cli-convert'=@('tests/e2e/ssh-orcad-windows-cli-matrix.spec.ts','@orcad-cli-convert')}
$electronBuilt=$false
if($Context.accounts.Count -lt $Cells.Count){throw 'Each cell needs its own private account'}
$seenApp=$false
foreach($id in $Cells){if($appCells.ContainsKey($id)){$seenApp=$true}elseif($seenApp){throw 'App cells must run last: they switch native modules to Electron'}}
if(-not $Context.forbiddenToolLog){throw 'Run the provisioning with -HiddenTools so toolchain calls are logged'}
$openSshKey='HKLM:\SOFTWARE\OpenSSH'
$windowsPowerShell=Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$knownPath=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ssh\known_hosts'
$knownExisted=Test-Path -LiteralPath $knownPath
$priorKnown=if($knownExisted){[IO.File]::ReadAllBytes($knownPath)}else{$null}
$priorBackground=$env:ORCA_BACKGROUND_LAUNCH
$failed=[Collections.Generic.List[string]]::new()
$summary=[Collections.Generic.List[hashtable]]::new()

function Invoke-PrivateSsh([string]$Account,[string]$Command,[switch]$RequireSuccess,[switch]$ReturnDetails) {
  $start=[Diagnostics.ProcessStartInfo]::new($Context.sshExe)
  $start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
  foreach($argument in @('-F','NUL','-T','-p',[string]$Context.port,'-i',$Context.identityFile,'-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o',"UserKnownHostsFile=$($Context.knownHosts)",'-o','ConnectTimeout=5',"$Account@127.0.0.1",$Command)){$start.ArgumentList.Add($argument)}
  $process=[Diagnostics.Process]::Start($start)
  try {
    $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
    if(-not $process.WaitForExit(30000)){$process.Kill($true);throw 'Private SSH probe deadline exceeded'}
    $value=$stdout.GetAwaiter().GetResult();$errorText=$stderr.GetAwaiter().GetResult()
    if($ReturnDetails){return [pscustomobject]@{exitCode=$process.ExitCode;stdout=$value;stderr=$errorText}}
    if($RequireSuccess -and $process.ExitCode -ne 0){
      throw "Private SSH command rejected under actual account $Account (exit $($process.ExitCode))"
    }
    return $value
  } finally {$process.Dispose()}
}

function Set-PrivateDefaultShell([string]$Shell) {
  if($Shell -eq 'powershell'){
    if(-not (Test-Path -LiteralPath $openSshKey)){New-Item -Path $openSshKey -Force | Out-Null}
    New-ItemProperty -LiteralPath $openSshKey -Name DefaultShell -Value $windowsPowerShell -PropertyType String -Force | Out-Null
  } elseif(Test-Path -LiteralPath $openSshKey) {
    Remove-ItemProperty -LiteralPath $openSshKey -Name DefaultShell -ErrorAction SilentlyContinue
  }
}

# Diagnostic ORCA_WMI=<ReturnValue>|denied: standard SSH logons lack root\cimv2 Remote Enable; Orca must launch without WMI.
function Test-PrivateWmiLaunch([string]$Account) {
  $out=Invoke-PrivateSsh $Account 'powershell.exe -NoProfile -NonInteractive -Command "try{$r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=''cmd.exe /d /c exit 0''} -ErrorAction Stop;''ORCA_WMI=''+$r.ReturnValue}catch{''ORCA_WMI=denied''}"'
  $match=[regex]::Match($out,'ORCA_WMI=(\S+)')
  if($match.Success){return $match.Groups[1].Value}else{return 'no-output'}
}

# Run app-level cells last: the e2e build switches natives to Electron’s ABI, which vitest cannot load.
function Invoke-AppCell($Account,[string]$Descriptor,[string]$Log,[string]$Spec,[string]$Grep) {
  $ready=Invoke-PrivateSsh $Account.name 'git init -q orca-convert-repo && git -C orca-convert-repo -c user.name=orca -c user.email=orca@example.invalid commit -q --allow-empty -m init && echo ORCA_REPO_READY'
  if($ready -notmatch 'ORCA_REPO_READY'){throw 'Could not create the convert cell repository as the account'}
  # Out of the app's default lookup, so the relay phase runs without a template.
  $template=Join-Path $env:RUNNER_TEMP 'orcad-convert-template'
  # Why guarded: Copy-Item into an existing folder nests the copy instead of replacing it.
  if(-not (Test-Path -LiteralPath $template)){Copy-Item -LiteralPath 'out\orcad-template' -Destination $template -Recurse -Force}
  Rename-Item -LiteralPath 'out\orcad-template' -NewName 'orcad-template.convert-hidden'
  try {
    if(-not $script:electronBuilt){
      & node config/scripts/ensure-native-runtime.mjs --runtime=electron 2>&1 | Tee-Object -FilePath $Log | Out-Host
      if($global:LASTEXITCODE -ne 0){Write-Host 'Switching native modules to Electron failed';return $global:LASTEXITCODE}
      & pnpm exec electron-vite build --mode e2e 2>&1 | Tee-Object -FilePath $Log -Append | Out-Host
      if($global:LASTEXITCODE -ne 0){Write-Host 'The e2e app build failed';return $global:LASTEXITCODE}
      $script:electronBuilt=$true
    }
    $env:ORCA_E2E_ORCAD_CONVERT_HOST=$Descriptor;$env:ORCA_E2E_ORCAD_CONVERT_TEMPLATE=$template;$env:SKIP_BUILD='1'
    $grepArgs=if($Grep){@('--grep',$Grep)}else{@()}
    & pnpm exec playwright test --config tests/playwright.config.ts $Spec @grepArgs --project=electron-headless --workers=1 2>&1 | Tee-Object -FilePath $Log -Append | Out-Host
    # Functions return uncaptured output, so only the exit code may reach the caller.
    return $global:LASTEXITCODE
  } finally {
    # Screenshots, traces and error context: Playwright clears test-results on the next cell's run.
    if(Test-Path -LiteralPath 'test-results'){Copy-Item -LiteralPath 'test-results' -Destination ($Log -replace '\.log$','.test-results') -Recurse -Force}
    Remove-Item Env:ORCA_E2E_ORCAD_CONVERT_HOST,Env:ORCA_E2E_ORCAD_CONVERT_TEMPLATE,Env:SKIP_BUILD -ErrorAction SilentlyContinue
    Rename-Item -LiteralPath 'out\orcad-template.convert-hidden' -NewName 'orcad-template'
  }
}

New-Item -ItemType Directory -Force -Path $ReceiptRoot | Out-Null
Push-Location $SourceRoot
try {
  if(-not (Test-Path -LiteralPath 'out\orcad-template')){throw 'Build the orcad template before provisioning'}
  # ssh2 consults the runner's known_hosts: pin only this private endpoint, restored below.
  New-Item -ItemType Directory -Force -Path (Split-Path $knownPath) | Out-Null
  Add-Content -LiteralPath $knownPath -Value ("`n"+[IO.File]::ReadAllText($Context.knownHosts))
  $env:ORCA_BACKGROUND_LAUNCH='1'
  # DefaultShell is still stock cmd here.
  $wmi=Test-PrivateWmiLaunch $Context.accounts[0].name
  Write-Host "Standard SSH user WMI Win32_Process.Create: $wmi (no grant; the orcad launch must not depend on it)"
  $summary.Add(@{standardUserWmiLaunch=$wmi;granted=$false})
  for($index=0;$index -lt $Cells.Count;$index++){
    $cell=$Cells[$index];$account=$Context.accounts[$index];$shell=$shells[$cell]
    Set-PrivateDefaultShell $shell
    # cmd expands %COMSPEC%; PowerShell prints it literally.
    $dispatch=Invoke-PrivateSsh $account.name 'echo %COMSPEC%'
    $dispatchShell=if($dispatch -match '(?i)\\cmd\.exe'){'cmd'}elseif($dispatch -match '%COMSPEC%'){'powershell'}else{'unknown'}
    if($dispatchShell -ne $shell){throw "DefaultShell $shell did not take effect for $cell (saw $dispatchShell)"}
    # G5 security gate: verify Docker under the ACTUAL unprivileged SSH identity.
    # The GitHub runner's elevated docker info is not evidence for this account.
    if($env:ORCA_G5_SSH_DOCKER_PRINCIPAL_PROBE -eq '1'){
      $principal=(Invoke-PrivateSsh $account.name 'whoami' -RequireSuccess).Trim()
      $expected='^[^\\]+\\'+[regex]::Escape($account.name)+'$'
      if(-not [regex]::IsMatch($principal,$expected,[System.Text.RegularExpressions.RegexOptions]::IgnoreCase)){
        throw "G5 SSH principal mismatch for $cell"
      }
      # The provisioner is the sole source of the intended Windows local SID.
      # A matching username under another machine/domain is not sufficient.
      if(-not $account.sid -or $account.sid -notmatch '^S-1-5-[0-9-]+$'){
        throw 'G5 expected SSH SID missing or malformed'
      }
      $identityCsv=(Invoke-PrivateSsh $account.name 'whoami /user /fo csv /nh' -RequireSuccess).Trim()
      $identity=@($identityCsv | ConvertFrom-Csv -Header @('principal','sid'))
      if($identity.Count -ne 1 -or $identity[0].sid -cne $account.sid -or
         $identity[0].principal -ine $principal){
        throw "G5 SSH authenticated principal SID mismatch for $cell"
      }
      if($env:ORCA_G5_SCOPED_BROKER_PROBE -eq '1'){
        # The standard SSH principal must NOT gain unrestricted Docker access.
        # Prove ACL denial at the SAME Skrog daemon endpoint the broker uses,
        # not merely a nonzero exit from PATH resolution or a missing user context.
        $dockerExe=Join-Path $env:WINDIR 'System32\docker.exe'
        if(-not(Test-Path -LiteralPath $dockerExe -PathType Leaf)){
          throw 'Pinned Docker CLI missing; direct ACL refusal cannot be tested'
        }
        $endpoint=(& $dockerExe context inspect skrog --format '{{.Endpoints.docker.Host}}'|Out-String).Trim()
        if($LASTEXITCODE -ne 0 -or $endpoint -cnotin @(
           'npipe:////./pipe/docker_engine','npipe:////./pipe/skrog_engine')){
          throw 'Expected local Skrog endpoint not available for scoped SSH ACL check'
        }
        $directCommand='"'+$dockerExe+'" -H '+$endpoint+' info --format "{{.OSType}}"'
        $direct=Invoke-PrivateSsh $account.name $directCommand -ReturnDetails
        if($direct.exitCode -eq 0){throw 'Unprivileged SSH account has broad direct Docker access'}
        if(($direct.stdout+$direct.stderr) -notmatch '(?i)(access is denied|access denied|access denied|permission denied|acesso negado)'){
          throw 'Direct Docker failed for an unverified reason, not a proven endpoint ACL refusal'
        }
        $directAclDenied=$true
        $pipeName='g5-'+[guid]::NewGuid().ToString('N').Substring(0,16)
        $serverScript=Join-Path $SourceRoot 'config/scripts/g5-scoped-docker-broker.ps1'
        $clientScript=Join-Path $SourceRoot 'config/scripts/g5-scoped-docker-broker-client.ps1'
        foreach($scriptPath in @($serverScript,$clientScript)){
          if(-not(Test-Path -LiteralPath $scriptPath)){throw 'Required G5 broker script missing'}
        }
        # On this disposable runner, explicitly prevent the SSH user from
        # replacing privileged broker code or its containing directories.
        # A deny-write ACE targets only the ephemeral account's exact SID.
        foreach($protected in @($SourceRoot,
            (Join-Path $SourceRoot 'config'),
            (Join-Path $SourceRoot 'config/scripts'),
            $serverScript,$clientScript)){
          $aclArg='*'+$account.sid+':(W)'
          & icacls.exe $protected '/deny' $aclArg | Out-Null
          if($LASTEXITCODE -ne 0){throw 'Could not protect G5 broker code from SSH account writes'}
        }
        $logBase=Join-Path $ReceiptRoot ($cell+'.broker')
        $serverProcess=Start-Process powershell.exe -ArgumentList @(
          '-NoProfile','-NonInteractive','-File',('"' + $serverScript + '"'),
          '-AuthorizedSid',$account.sid,'-PipeName',$pipeName
        ) -PassThru -WindowStyle Hidden -RedirectStandardOutput ($logBase+'.out.log') -RedirectStandardError ($logBase+'.err.log')
        try{
          Start-Sleep -Milliseconds 900
          if($serverProcess.HasExited){throw 'G5 broker exited before SSH client connection'}
          $clientCommand='powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$clientScript+'" -PipeName '+$pipeName+' -ExpectedServerPid '+$serverProcess.Id
          $reply=(Invoke-PrivateSsh $account.name $clientCommand -RequireSuccess).Trim()
          if($reply -cne 'G5_SCOPED_BROKER_ENGINE_LINUX_OK'){
            throw 'G5 scoped SSH identity broker did not prove Linux Docker'
          }
          if(-not $serverProcess.WaitForExit(10000) -or $serverProcess.ExitCode -ne 0){
            throw 'G5 scoped broker did not terminate cleanly'
          }
          $summary.Add(@{cell=$cell;sshPrincipal=$principal;sshPrincipalSid=$account.sid;
            directSkrogPipeAclDenialVerified=$directAclDenied;scopedBrokerReadOnlyLinux=$true;
            fullG5RemoteInstallerQualified=$false})
          Write-Host ('G5_SSH_SCOPED_READ_ONLY_BROKER_PASS cell='+$cell)
        }finally{
          if(-not $serverProcess.HasExited){Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue}
          $serverProcess.Dispose()
        }
      }else{
        $dockerAnswer=(Invoke-PrivateSsh $account.name 'docker info --format "{{.OSType}}"' -RequireSuccess).Trim()
        $authorized=($dockerAnswer -eq 'linux')
        $summary.Add(@{cell=$cell;sshPrincipal=$principal;sshDockerLinuxAuthorized=$authorized;
          verifiedUnderActualSshIdentity=$true;dockerOutput=($dockerAnswer.Substring(0,[Math]::Min(200,$dockerAnswer.Length)))})
        Write-Host "G5 SSH account Docker authorization: $cell, principal=$principal, linux=$authorized"
        if(-not $authorized){throw "G5 SSH account cannot access Linux Docker; full installer must remain HOLD ($cell)"}
      }
    }
    if(Test-Path -LiteralPath $Context.forbiddenToolLog){Move-Item -LiteralPath $Context.forbiddenToolLog -Destination (Join-Path $ReceiptRoot "$cell.before.forbidden-tool-calls.log")}
    $descriptor=Join-Path $ReceiptRoot "$cell.descriptor.json"
    @{cell=$cell;target=$Target;host='127.0.0.1';port=[int]$Context.port;username=$account.name;identityFile=$Context.identityFile;home=$account.home;forbiddenToolLog=$Context.forbiddenToolLog;receipt=(Join-Path $ReceiptRoot "$cell.json")} | ConvertTo-Json | Set-Content -LiteralPath $descriptor -Encoding utf8NoBOM
    $env:ORCA_RUN_SSH_WINDOWS_HOST='1';$env:ORCA_SSH_WINDOWS_HOST_CELL=$descriptor
    Write-Host "Windows host cell $cell ($Target, DefaultShell $shell, account $($account.name))"
    if($appCells.ContainsKey($cell)){
      $code=Invoke-AppCell $account $descriptor (Join-Path $ReceiptRoot "$cell.log") $appCells[$cell][0] $appCells[$cell][1]
    } else {
      if(-not $cell.StartsWith('orcad-')){throw "Unknown Windows host cell $cell"}
      $lane='src/main/managed-server/host-state/orcad-windows-host-lane.test.ts'
      & node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts $lane --reporter=verbose 2>&1 | Tee-Object -FilePath (Join-Path $ReceiptRoot "$cell.log")
      # Why global: under the workflow's GetNewClosure callback, bare $LASTEXITCODE reads a stale captured copy.
      $code=$global:LASTEXITCODE
    }
    # orcad.log holds only the last launch on Windows; orcad.log.1 is the one before a restart.
    foreach($log in @(Get-ChildItem -Path (Join-Path $account.home '.orca-remote\orcad-*\orcad.log'),(Join-Path $account.home '.orca-remote\orcad-*\orcad.log.1') -File -ErrorAction SilentlyContinue)){Copy-Item -LiteralPath $log.FullName -Destination (Join-Path $ReceiptRoot "$cell.$($log.Directory.Name).$($log.Name)")}
    if(Test-Path -LiteralPath $Context.forbiddenToolLog){Copy-Item -LiteralPath $Context.forbiddenToolLog -Destination (Join-Path $ReceiptRoot "$cell.forbidden-tool-calls.log")}
    $summary.Add(@{cell=$cell;shell=$shell;account=$account.name;exitCode=$code})
    if($code -ne 0){$failed.Add($cell)}
  }
  # Host processes can outlive their client; wait so cleanup can unload the profiles.
  $homes=@($Context.accounts | ForEach-Object {$_.home.TrimEnd('\')+'\'})
  $graceDeadline=[DateTime]::UtcNow.AddSeconds(120)
  do {
    $hostProcesses=@(Get-CimInstance Win32_Process | Where-Object {$path=$_.ExecutablePath;$path -and @($homes | Where-Object {$path.StartsWith($_,[StringComparison]::OrdinalIgnoreCase)}).Count})
    if(-not $hostProcesses.Count){break};Start-Sleep -Seconds 2
  } while([DateTime]::UtcNow -lt $graceDeadline)
  $summary.Add(@{hostProcessesAfterGrace=@($hostProcesses | ForEach-Object {[IO.Path]::GetFileName($_.ExecutablePath)})})
} finally {
  Set-PrivateDefaultShell 'cmd'
  if($knownExisted){[IO.File]::WriteAllBytes($knownPath,$priorKnown)}else{Remove-Item -LiteralPath $knownPath -Force -ErrorAction SilentlyContinue}
  $env:ORCA_BACKGROUND_LAUNCH=$priorBackground
  Remove-Item Env:ORCA_RUN_SSH_WINDOWS_HOST,Env:ORCA_SSH_WINDOWS_HOST_CELL -ErrorAction SilentlyContinue
  $summary | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $ReceiptRoot 'summary.json') -Encoding utf8NoBOM
  Pop-Location
}
if($failed.Count){throw "Windows host cells failed: $($failed -join ', ')"}
