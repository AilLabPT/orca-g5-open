# Nonprivileged Windows SSH identity client for the G5 scoped broker.
# Does not grant Docker access or accept arbitrary Docker parameters.
[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidatePattern('^g5-[a-z0-9-]{8,52}$')][string]$PipeName,
  [Parameter(Mandatory)][ValidateRange(1,2147483647)][int]$ExpectedServerPid,
  [ValidateSet('engine-linux','docker-run','docker-exec','docker-socket','ensure','rollback')][string]$Operation='engine-linux',
  [ValidateRange(1000,10000)][int]$TimeoutMs=5000
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
# Kernel-provided server PID prevents acceptance of a same-name spoofed pipe.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class G5PipeServerIdentity {
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint serverPid);
}
'@
$pipe=[IO.Pipes.NamedPipeClientStream]::new('.',$PipeName,[IO.Pipes.PipeDirection]::InOut,[IO.Pipes.PipeOptions]::Asynchronous,[Security.Principal.TokenImpersonationLevel]::Identification)
try{
  $pipe.Connect($TimeoutMs)
  [uint32]$remotePid=0
  if(-not [G5PipeServerIdentity]::GetNamedPipeServerProcessId($pipe.SafePipeHandle,[ref]$remotePid) -or
     $remotePid -ne [uint32]$ExpectedServerPid){throw 'G5_BROKER_SERVER_IDENTITY_MISMATCH'}
  $read=[IO.StreamReader]::new($pipe,[Text.Encoding]::UTF8,$false,1024,$true)
  $write=[IO.StreamWriter]::new($pipe,[Text.UTF8Encoding]::new($false),1024,$true)
  $write.AutoFlush=$true
  try{
    $write.WriteLine((@{op=$Operation}|ConvertTo-Json -Compress))
    # Bound the response WHILE reading, not after an unbounded ReadLineAsync.
    $buffer=New-Object char[] 1
    $acc=[Text.StringBuilder]::new()
    $deadline=[DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
    while($acc.Length -le 1024){
      $remaining=[int][Math]::Max(1,($deadline-[DateTime]::UtcNow).TotalMilliseconds)
      if($remaining -le 1){throw 'G5_BROKER_RESPONSE_DEADLINE'}
      $task=$read.ReadAsync($buffer,0,1)
      if(-not $task.Wait($remaining)){throw 'G5_BROKER_RESPONSE_DEADLINE'}
      if($task.Result -ne 1){throw 'G5_BROKER_RESPONSE_INCOMPLETE'}
      if($buffer[0] -eq [char]10){break}
      if($buffer[0] -ne [char]13){$null=$acc.Append($buffer[0])}
    }
    if($acc.Length -gt 1024){throw 'G5_BROKER_REPLY_TOO_LONG'}
    $answer=$acc.ToString()
    if(!$answer){throw 'G5_BROKER_REPLY_INVALID'}
    $parsed=$answer|ConvertFrom-Json
    if($parsed.ok -ne $true -or $parsed.dockerOS -cne 'linux' -or
       $parsed.authorization -cne 'read-only-scoped-broker'){
      throw 'G5_BROKER_OPERATION_REJECTED'
    }
    Write-Output 'G5_SCOPED_BROKER_ENGINE_LINUX_OK'
  }finally{
    try{$write.Dispose()}catch{}
    try{$read.Dispose()}catch{}
  }
}finally{try{$pipe.Dispose()}catch{}}
