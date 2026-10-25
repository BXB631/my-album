param(
  [Parameter(Mandatory = $true)][string]$ResultPath,
  [string]$InitialPath = '',
  [string]$Description = 'Select the folder that contains your photos',
  [switch]$SelfTest = $false
)

# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads .ps1 files as the
# system ANSI codepage unless they carry a UTF-8 BOM, so non-ASCII text here would be
# mangled into syntax errors. Chinese labels are passed in as arguments instead.
#
# This script is only the FALLBACK: the packaged app ships MyAlbumPicker.exe
# (installer\picker\MyAlbumPicker.cs) and uses that first. It exists because
# spawning PowerShell is slower and its .NET version varies.

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

try {
  [System.Windows.Forms.Application]::EnableVisualStyles()
} catch {
  # Visual styles are optional for this native dialog.
}

$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = $Description
$dialog.ShowNewFolderButton = $false

# Do NOT set $dialog.UseDescriptionForTitle here. That property only exists in
# .NET Core 5+; Windows PowerShell 5.1 runs on .NET Framework, where assigning it
# throws PropertyAssignmentException and kills the whole script (been there).

if ($SelfTest) {
  # Build the objects only (no window): used by the packaging/test flow.
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($ResultPath, 'SELFTEST OK', $utf8)
  Write-Output 'SELFTEST OK'
  exit 0
}

# Why the owner window: when the server runs elevated (as administrator), the dialog
# belongs to the elevated process and can easily end up *behind* the browser window --
# which looks exactly like "clicking the button does nothing". A topmost invisible
# owner keeps it in front.
$owner = New-Object System.Windows.Forms.Form
$owner.Text = 'My Album'
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Opacity = 0
$owner.Show()
$owner.Activate()

if ($InitialPath -and (Test-Path -LiteralPath $InitialPath -PathType Container)) {
  try {
    $dialog.SelectedPath = (Resolve-Path -LiteralPath $InitialPath).Path
  } catch {
    # Use the default starting location when the saved folder is unavailable.
  }
}

try {
  $result = $dialog.ShowDialog($owner)
} finally {
  try { $owner.Close(); $owner.Dispose() } catch { }
}

if ($result -ne [System.Windows.Forms.DialogResult]::OK) {
  exit 2
}

$selectedPath = $dialog.SelectedPath

if ([string]::IsNullOrWhiteSpace($selectedPath)) {
  exit 2
}

$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($ResultPath, $selectedPath, $utf8)
exit 0