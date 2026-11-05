param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('protect', 'unprotect')]
    [string]$Mode
)

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Security
$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser
$inputText = [Console]::In.ReadToEnd()
if ($Mode -eq 'protect') {
    $bytes = [Text.Encoding]::UTF8.GetBytes($inputText)
    $encrypted = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, $scope)
    [Console]::Out.Write([Convert]::ToBase64String($encrypted))
} else {
    $encrypted = [Convert]::FromBase64String($inputText)
    $bytes = [Security.Cryptography.ProtectedData]::Unprotect($encrypted, $null, $scope)
    [Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
}
