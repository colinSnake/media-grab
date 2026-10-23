$ErrorActionPreference = 'Stop'
$bundle = Join-Path $PWD 'apps/desktop/src-tauri/target/release/bundle/nsis'
$installers = @(Get-ChildItem -LiteralPath $bundle -Filter '*.exe' -File)
if ($installers.Count -ne 1) { throw "Expected one NSIS installer in $bundle, found $($installers.Count)" }

$installDir = Join-Path $env:RUNNER_TEMP 'mediagrab-installed-smoke'
if ($installDir -match '\s') { throw 'NSIS /D= requires a runner installation path without spaces' }
$installer = Start-Process -FilePath $installers[0].FullName -ArgumentList @('/S', "/D=$installDir") -PassThru
if (-not $installer.WaitForExit(120000)) {
  $installer.Kill()
  throw 'NSIS silent installation timed out'
}
if ($installer.ExitCode -ne 0) { throw "NSIS installation failed with exit code $($installer.ExitCode)" }

$executables = @(Get-ChildItem -LiteralPath $installDir -Recurse -File -Filter '*.exe' |
  Where-Object { $_.Name -match 'mediagrab' -and $_.Name -notmatch 'uninstall|unins|setup' })
if ($executables.Count -ne 1) {
  throw "Expected one installed MediaGrab executable in $installDir, found $($executables.Count)"
}
node scripts/smoke-installed-desktop.mjs $executables[0].FullName
if ($LASTEXITCODE -ne 0) { throw "Installed Windows desktop smoke check failed: $LASTEXITCODE" }
