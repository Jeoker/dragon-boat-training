param([string]$PrivateDirectory = 'D:\private-backup-20261004')
$ErrorActionPreference = 'Stop'
$setupRoot = $PrivateDirectory
$script:setupPhase = 'LOCAL_IDENTITY'
$script:setupReason = $null; $script:setupStatus = $null; $script:setupField = $null
function Stop-Setup([string]$Reason, [string]$Field = '') {
  $script:setupReason = $Reason
  $script:setupField = $Field
  throw 'BACKUP_SETUP_UNCONFIRMED'
}
function Assert-SetupPrivate([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Stop-Setup 'REPARSE_PATH' }
  $acl = Get-Acl -LiteralPath $Path
  if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -notin $setupAllowed) { Stop-Setup 'ACL_REJECTED' }
  foreach ($rule in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $setupAllowed) { Stop-Setup 'ACL_REJECTED' }
  }
}
function Write-SetupJson([string]$Path, $Value) {
  Assert-SetupPrivate ([IO.Path]::GetDirectoryName($Path))
  $bytes = [Text.Encoding]::UTF8.GetBytes(($Value | ConvertTo-Json -Depth 8 -Compress))
  $stream = [IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
  Assert-SetupPrivate $Path
}
$setupTransport = $null; $setupCode = $null; $setupReply = $null
$secureTransport = $null; $secureCode = $null
try {
  $setupSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $setupAllowed = @($setupSid.Value, 'S-1-5-18', 'S-1-5-32-544')
  $script:setupPhase = 'PATH'
  if ($PrivateDirectory -notmatch '^[A-Za-z]:\\' -or
      -not [string]::Equals([IO.Path]::GetFullPath($PrivateDirectory),$PrivateDirectory,[StringComparison]::OrdinalIgnoreCase)) { Stop-Setup 'INVALID_PATH' }
  $setupRepository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
  if ([string]::Equals($setupRoot,$setupRepository,[StringComparison]::OrdinalIgnoreCase) -or
      $setupRoot.StartsWith($setupRepository + '\',[StringComparison]::OrdinalIgnoreCase)) { Stop-Setup 'REPOSITORY_PATH' }
  if (Test-Path -LiteralPath $setupRoot) { Stop-Setup 'EXISTING_DIRECTORY' }
  # Check every existing ancestor before creating a fresh directory.
  $ancestor = [IO.Path]::GetDirectoryName($setupRoot)
  while ($ancestor) {
    if (-not (Test-Path -LiteralPath $ancestor -PathType Container)) { Stop-Setup 'PARENT_NOT_FOUND' }
    if (((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Stop-Setup 'REPARSE_PATH' }
    if (Test-Path -LiteralPath (Join-Path $ancestor '.git')) { Stop-Setup 'REPOSITORY_PATH' }
    $ancestor = [IO.Path]::GetDirectoryName($ancestor)
  }
  $script:setupPhase = 'DIRECTORY_CREATE'
  [void](New-Item -ItemType Directory -Path $setupRoot -ErrorAction Stop)
  $script:setupPhase = 'ACL'
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetOwner($setupSid); $acl.SetAccessRuleProtection($true,$false)
  foreach ($sid in $setupAllowed) {
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
      (New-Object System.Security.Principal.SecurityIdentifier($sid)), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $setupRoot -AclObject $acl
  Assert-SetupPrivate $setupRoot
  $script:setupPhase = 'CHILD_DIRECTORIES'
  foreach ($name in @('checkpoint','output')) { [void](New-Item -ItemType Directory -Path (Join-Path $setupRoot $name) -ErrorAction Stop); Assert-SetupPrivate (Join-Path $setupRoot $name) }
  $script:setupPhase = 'INPUT'
  $secureTransport = Read-Host 'Existing isolated C1_TEST_KEY' -AsSecureString
  $secureCode = Read-Host 'Isolated Coach Code' -AsSecureString
  $ptr = [IntPtr]::Zero
  try { $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureTransport); $setupTransport = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { if ($ptr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr); $ptr = [IntPtr]::Zero } }
  try { $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureCode); $setupCode = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { if ($ptr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr); $ptr = [IntPtr]::Zero } }
  if ([string]::IsNullOrWhiteSpace($setupTransport) -or [string]::IsNullOrWhiteSpace($setupCode)) { Stop-Setup 'INPUT_EMPTY' }
  $setupOrigin = 'https://dragon-boat-training-api-c2-test.dragon-boat-training.workers.dev'
  function Invoke-SetupC1([string]$Action, $Body) {
    try {
      $reply = Invoke-RestMethod -Method Post -Uri "$setupOrigin/internal/c1/$Action" -Headers @{ Authorization = "Bearer $setupTransport" } -ContentType 'application/json' -Body ($Body | ConvertTo-Json -Compress) -MaximumRedirection 0 -TimeoutSec 30
    } catch {
      # Read only the numeric status. Never render exception messages, bodies or headers.
      $status = $null
      try { $status = [int]$_.Exception.Response.StatusCode } catch { $status = $null }
      if ($status -ge 100 -and $status -le 599) { $script:setupStatus = $status; Stop-Setup 'HTTP_FAILURE' }
      Stop-Setup 'NETWORK_FAILED'
    }
    if ($reply.ok -ne $true) { Stop-Setup 'RESPONSE_NOT_CONFIRMED' }
    $meta = $reply.meta
    $expectedMeta = [ordered]@{ request_id = $Body.request_id; contract_version = '2026-09-21.c1.5'; environment = 'staging'; backend_instance = 'dragon-boat-training-c2-test'; backend_generation = 'cf-c2-isolated-1'; writer_epoch = 0 }
    foreach ($field in $expectedMeta.Keys) {
      if ($null -eq $meta -or $null -eq $meta.$field -or $meta.$field -ne $expectedMeta[$field]) { Stop-Setup 'IDENTITY_MISMATCH' $field }
    }
    return $reply
  }
  $script:setupPhase = 'LOGIN'
  $setupReply = Invoke-SetupC1 'coach-login' @{ request_id = ('setup_login_' + [Guid]::NewGuid().ToString('N')); coach_code = $setupCode }
  $setupToken = $setupReply.data.result.session_token
  $script:setupPhase = 'LOGIN_REPLY'
  if (-not ($setupToken -is [string]) -or $setupToken.Length -lt 32) { Stop-Setup 'LOGIN_REPLY_INVALID' }
  $script:setupPhase = 'BOOTSTRAP'
  $bootstrap = Invoke-SetupC1 'coach-bootstrap' @{ request_id = ('setup_read_' + [Guid]::NewGuid().ToString('N')); session_token = $setupToken }
  $script:setupPhase = 'OPERATIONS'
  $operations = Invoke-SetupC1 'get-operations' @{ request_id = ('setup_read_' + [Guid]::NewGuid().ToString('N')); session_token = $setupToken }
  $script:setupPhase = 'ACTOR_SCHEMA'
  if (-not ($setupReply.data.result.coach_id -is [string]) -or [string]::IsNullOrWhiteSpace($setupReply.data.result.coach_id) -or $bootstrap.data.coach.coach_id -ne $setupReply.data.result.coach_id) { Stop-Setup 'ACTOR_MISMATCH' 'coach_id' }
  if ($operations.data.schema_version -notin @(14,16)) { Stop-Setup 'SCHEMA_MISMATCH' 'schema_version' }
  if (-not ($setupReply.meta.service_version -is [string]) -or [string]::IsNullOrWhiteSpace($setupReply.meta.service_version) -or $operations.meta.service_version -ne $setupReply.meta.service_version -or $bootstrap.meta.service_version -ne $setupReply.meta.service_version) { Stop-Setup 'SERVICE_VERSION_MISMATCH' 'service_version' }
  $credentials = Join-Path $setupRoot 'credentials.json'
  $script:setupPhase = 'WRITE_CREDENTIALS'
  Write-SetupJson $credentials @{ transport_key = $setupTransport; session_token = $setupToken }
  $script:setupPhase = 'WRITE_CONFIG'
  Write-SetupJson (Join-Path $setupRoot 'config.json') @{
    format = 'c2-isolated-business-backup-v1'
    server = @{ origin = $setupOrigin; team_id = 'pentasus-c2-test'; backend_instance = 'dragon-boat-training-c2-test'; backend_generation = 'cf-c2-isolated-1'; writer_epoch = 0 }
    schema_version = $operations.data.schema_version
    request_id = ('backup_' + [Guid]::NewGuid().ToString('N'))
    credentials_file = $credentials; store_directory = (Join-Path $setupRoot 'checkpoint')
    output_file = (Join-Path $setupRoot 'output\protected-backup.json')
  }
  'PRIVATE_BACKUP_CONFIG_READY'
} catch {
  if (-not $script:setupReason) {
    if ($_.Exception -is [UnauthorizedAccessException]) { $script:setupReason = 'ACCESS_DENIED' }
    else { $script:setupReason = 'LOCAL_OPERATION_FAILED' }
  }
  $safeDiagnostic = 'BACKUP_SETUP_UNCONFIRMED phase=' + $script:setupPhase + ' reason=' + $script:setupReason
  if ($script:setupStatus) { $safeDiagnostic += ' status=' + $script:setupStatus }
  if ($script:setupField) { $safeDiagnostic += ' field=' + $script:setupField }
  throw $safeDiagnostic
}
finally {
  if ($secureTransport) { $secureTransport.Dispose() }; if ($secureCode) { $secureCode.Dispose() }
  $setupTransport = $null; $setupCode = $null; $setupToken = $null; $setupReply = $null
}
