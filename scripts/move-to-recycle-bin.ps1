param([Parameter(Mandatory)][string]$LiteralPath, [Parameter(Mandatory)][string]$AllowedRoot)
$ErrorActionPreference = 'Stop'
$taskRoot = (Get-Item -LiteralPath $AllowedRoot).FullName.TrimEnd('\')
$taskTarget = Get-Item -LiteralPath $LiteralPath
if ($taskTarget.DirectoryName -eq $taskRoot -or (Split-Path -Parent $taskTarget.FullName) -eq $taskRoot) {
  if ($taskTarget.FullName -eq $taskRoot -or $taskTarget.LinkType -or ($taskTarget.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Linked or broad recycle target refused' }
} else { throw 'Recycle target must be an immediate child of the approved build-recycle directory' }
$taskDrive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($taskTarget.FullName))
if ($taskDrive.DriveType -ne [IO.DriveType]::Fixed) { throw 'Only a local fixed drive with OS recycling is supported' }
function Test-TaskTree([string]$TaskPath) {
  $taskItem = Get-Item -LiteralPath $TaskPath
  if ($taskItem.LinkType -or ($taskItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Linked recycle content requires review' }
  if ($taskItem.PSIsContainer) { foreach ($taskChild in Get-ChildItem -LiteralPath $TaskPath -Force) { Test-TaskTree $taskChild.FullName } }
}
Test-TaskTree $taskTarget.FullName
Add-Type -AssemblyName Microsoft.VisualBasic
# SendToRecycleBin is recoverable shell recycling; never use permanent removal.
if ($taskTarget.PSIsContainer) {
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($taskTarget.FullName, 'OnlyErrorDialogs', 'SendToRecycleBin', 'ThrowException')
} else {
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($taskTarget.FullName, 'OnlyErrorDialogs', 'SendToRecycleBin', 'ThrowException')
}
if (Test-Path -LiteralPath $LiteralPath) { throw 'Recycle operation did not complete' }
