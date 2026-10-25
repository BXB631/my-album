param(
  [Parameter(Mandatory = $true)][string[]]$Files,
  [string]$Pfx = '',
  [string]$Password = '',
  [string]$Thumbprint = '',
  [string]$Timestamp = '',
  [switch]$EnsureDevCert = $false,
  [Parameter(Mandatory = $true)][string]$ResultFile
)

# NOTE: keep this file ASCII-only (Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI).

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Core

$flags = [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet

function New-DevCertificate([string]$path) {
  # A self-signed certificate, created without touching the certificate store
  # (some locked-down environments deny New-SelfSignedCertificate).
  # It MUST carry the Code Signing EKU, otherwise Authenticode refuses it with
  # "The specified certificate is not suitable for code signing".
  $rsa = [System.Security.Cryptography.RSA]::Create(2048)
  $request = New-Object System.Security.Cryptography.X509Certificates.CertificateRequest(
    'CN=MyAlbum Dev Signing', $rsa,
    [System.Security.Cryptography.HashAlgorithmName]::SHA256,
    [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)

  $usages = New-Object System.Security.Cryptography.OidCollection
  [void]$usages.Add((New-Object System.Security.Cryptography.Oid('1.3.6.1.5.5.7.3.3')))
  $request.CertificateExtensions.Add(
    (New-Object System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension(
      $usages, $false)))

  $request.CertificateExtensions.Add(
    (New-Object System.Security.Cryptography.X509Certificates.X509KeyUsageExtension(
      [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature, $false)))

  $request.CertificateExtensions.Add(
    (New-Object System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension(
      $false, $false, 0, $false)))

  $created = $request.CreateSelfSigned(
    [DateTimeOffset]::Now.AddDays(-1), [DateTimeOffset]::Now.AddYears(3))
  $directory = Split-Path -Parent $path
  if ($directory -and -not (Test-Path -LiteralPath $directory)) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
  }
  [System.IO.File]::WriteAllBytes($path, $created.Export(
    [System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx))
  return $created
}

function Resolve-Certificate() {
  # An empty password must be passed as $null: with a .pfx that has no password,
  # passing '' makes .NET throw "the specified network password is not correct".
  $effective = if ([string]::IsNullOrEmpty($Password)) { $null } else { $Password }

  if ($Pfx -and (Test-Path -LiteralPath $Pfx)) {
    try {
      return [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
        $Pfx, $effective, $flags)
    } catch {
      # 读不出来（文件坏了/被别的东西占着/密码不对）：
      # 要的是开发证书的话就重新生成一张，别让整个签名流程莫名跳过
      if (-not $EnsureDevCert) { throw }
      Remove-Item -LiteralPath $Pfx -Force -ErrorAction SilentlyContinue
      return New-DevCertificate $Pfx
    }
  }

  if ($Thumbprint) {
    $found = Get-ChildItem Cert:\CurrentUser\My, Cert:\LocalMachine\My -ErrorAction SilentlyContinue |
      Where-Object { $_.Thumbprint -eq $Thumbprint } | Select-Object -First 1
    if ($found) { return $found }
  }

  if ($EnsureDevCert) {
    if (-not $Pfx) { throw 'EnsureDevCert needs -Pfx' }
    return New-DevCertificate $Pfx
  }

  return $null
}

$results = New-Object System.Collections.ArrayList
$certificate = $null
$certificateError = ''

try {
  $certificate = Resolve-Certificate
} catch {
  $certificateError = $_.Exception.Message
}

if (-not $certificate) {
  $payload = @{
    ok = $false
    skipped = $true
    reason = if ($certificateError) { $certificateError } else { 'no certificate' }
    entries = @()
  }
  [System.IO.File]::WriteAllText($ResultFile, ($payload | ConvertTo-Json -Depth 5),
    (New-Object System.Text.UTF8Encoding($false)))
  exit 2
}

foreach ($file in $Files) {
  $entry = @{ file = $file; status = 'unknown'; subject = ''; thumbprint = ''; error = '' }

  try {
    if (-not (Test-Path -LiteralPath $file)) {
      throw "file not found: $file"
    }

    $arguments = @{
      FilePath = $file
      Certificate = $certificate
      HashAlgorithm = 'SHA256'
    }

    if ($Timestamp) { $arguments.TimestampServer = $Timestamp }

    $signature = Set-AuthenticodeSignature @arguments
    $verify = Get-AuthenticodeSignature -FilePath $file

    $entry.status = [string]$verify.Status
    $entry.subject = if ($verify.SignerCertificate) { $verify.SignerCertificate.Subject } else { '' }
    $entry.thumbprint = if ($verify.SignerCertificate) { $verify.SignerCertificate.Thumbprint } else { '' }

    if ($verify.Status -eq 'UnknownError' -and $entry.subject -eq '') {
      $entry.error = 'signature not present after signing'
    }
    if ($signature.StatusMessage) { $entry.error = [string]$signature.StatusMessage }
  } catch {
    $entry.status = 'failed'
    $entry.error = $_.Exception.Message
  }

  [void]$results.Add($entry)
}

$failed = @($results | Where-Object { $_.subject -eq '' }).Count

$payload = @{
  ok = ($failed -eq 0)
  skipped = $false
  reason = ''
  subject = $certificate.Subject
  thumbprint = $certificate.Thumbprint
  entries = $results
}

[System.IO.File]::WriteAllText($ResultFile, ($payload | ConvertTo-Json -Depth 5),
  (New-Object System.Text.UTF8Encoding($false)))

if ($failed -gt 0) { exit 1 }
exit 0