# Unit-level adversarial isolation contract with an in-process Docker CLI fixture.
# This does NOT claim a real Docker or SSH end-to-end qualification.
$ErrorActionPreference='Stop'
$adapter=Join-Path $PSScriptRoot 'G5-Windows-DockerUpdater.ps1'
$image='sha256:'+('a'*64)
$id='b'*64
$script:CurrentCase='clean'
$script:Commands=@()
function docker {
  $argv=@($args)
  $script:Commands+=($argv -join ' ')
  $global:LASTEXITCODE=0
  if($argv[0] -eq 'info'){ 'linux';return }
  if($argv[0] -eq 'inspect'){
    $format=[string]$argv[-1]
    if($format -eq '{{.State.Running}}|{{.HostConfig.NetworkMode}}|{{.HostConfig.RestartPolicy.Name}}|{{.Image}}|{{.Id}}'){
      'true|none|no|'+$image+'|'+$id;return
    }
    if($format -eq '{{json .HostConfig}}'){
      $config=[ordered]@{
        Privileged=$false;NetworkMode='none';PublishAllPorts=$false
        PidMode='';IpcMode='private';UTSMode='';UsernsMode='';CgroupnsMode='private'
        Binds=$null;Mounts=$null;VolumesFrom=$null;Devices=@();DeviceRequests=@()
        CapAdd=$null;SecurityOpt=$null;Tmpfs=$null;PortBindings=@{};Links=$null
      }
      if($script:CurrentCase -eq 'privileged'){$config.Privileged=$true}
      if($script:CurrentCase -eq 'host-pid'){$config.PidMode='host'}
      if($script:CurrentCase -eq 'host-ipc'){$config.IpcMode='host'}
      if($script:CurrentCase -eq 'added-capability'){$config.CapAdd=@('SYS_ADMIN')}
      if($script:CurrentCase -eq 'device'){$config.Devices=@(@{PathOnHost='/dev/kvm'})}
      if($script:CurrentCase -eq 'socket-bind'){$config.Binds=@('/var/run/docker.sock:/var/run/docker.sock')}
      if($script:CurrentCase -eq 'port-binding'){$config.PortBindings=@{'8080/tcp'=@(@{HostPort='8080'})}}
      $config | ConvertTo-Json -Compress -Depth 8;return
    }
    if($format -eq '{{json .Mounts}}'){
      if($script:CurrentCase -eq 'mount'){ '[{"Type":"bind","Source":"/sensitive","Destination":"/host"}]' }
      else { '[]' }
      return
    }
    if($format -eq '{{.Id}}'){$id;return}
    if($format -eq '{{.State.StartedAt}}'){'2026-11-17T00:00:00Z';return}
    throw 'Unexpected Docker inspect format in isolation fixture'
  }
  if($argv[0] -eq 'exec'){
    if($argv -contains 'inspect'){'{"active":"v11","fallbackAvailable":true,"sourceCommit":"fixture-unit-test"}';return}
    if(($argv -join ' ') -match 'ps -o args='){'python3 /opt/g5-sources/v11/g5-bun54-slot/orcad.js';return}
    throw 'Unexpected Docker exec in isolation fixture'
  }
  if($argv[0] -eq 'logs'){return}
  throw ('Unexpected Docker fixture command: '+($argv -join ' '))
}
$ok=0
foreach($case in @('clean','privileged','host-pid','host-ipc','added-capability','device','socket-bind','port-binding','mount')){
  $script:CurrentCase=$case
  $script:Commands=@()
  try {
    $global:LASTEXITCODE=0
    $output=. $adapter -Action Status -Container 'g5-isolated-unit' -ExpectedImageId $image
    if($case -ne 'clean'){throw ('UNSAFE_FIXTURE_ACCEPTED: '+$case)}
    $state=@($output|Where-Object{$_ -is [string] -and $_.StartsWith('{')})|Select-Object -Last 1
    if(-not $state){throw 'Clean isolated fixture did not complete Status'}
    $status=$state|ConvertFrom-Json
    if($status.containerId -ne $id){throw 'Clean immutable ID mismatch'}
    Write-Host 'G5_ISOLATION_CLEAN_PASS'
  }catch{
    $msg=$_.Exception.Message
    if($case -eq 'clean' -or $msg -match 'UNSAFE_FIXTURE_ACCEPTED'){throw}
    if($msg -notmatch 'G5 Docker .*forbidden|G5 Docker unsafe'){throw ('WRONG_FAILURE '+$case+': '+$msg)}
    if($script:Commands -match 'exec '){throw ('UNSAFE_EXEC_BEFORE_DENIAL '+$case)}
    Write-Host ('G5_ISOLATION_REJECTED_'+$case)
  }
  $ok++
}
if($ok -ne 9){throw 'G5 isolation test coverage incomplete'}
Write-Host 'G5_ISOLATION_CONTRACT_9_OF_9_PASS'
