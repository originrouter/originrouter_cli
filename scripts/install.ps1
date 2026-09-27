param(
    [string]$Release = $(if ($env:ORIGINROUTER_RELEASE) { $env:ORIGINROUTER_RELEASE } else { "latest" }),
    [switch]$Yes,
    [switch]$NoProxy,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PackageName = "@originrouter/cli"
$MinimumNodeMajor = 22

if ($Release -notmatch '^(latest|\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?)$') {
    Write-Error "Invalid release: $Release. Expected latest or a semantic version."
    exit 1
}

# Inherit the system proxy so npm (which ignores Windows proxy settings) can
# reach the registry behind local proxies such as Clash. The .NET HttpClient
# picks up the system proxy on its own; ORIGINROUTER_PROXY overrides, -NoProxy skips.
function Get-SystemProxy {
    if ($NoProxy) { return $null }
    if ($env:ORIGINROUTER_PROXY) { return $env:ORIGINROUTER_PROXY }
    if ($env:HTTPS_PROXY) { return $null }  # already set in the environment; keep it
    try {
        $settings = Get-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings"
        if (-not $settings.ProxyEnable) { return $null }
        $server = $settings.ProxyServer
        if (-not $server) { return $null }
        if ($server -notmatch "=") { return "http://$server" }
        foreach ($part in $server.Split(";")) {
            if ($part -match "^https?=(.+)$") { return "http://$($Matches[1])" }
        }
    } catch { }
    return $null
}

$systemProxy = Get-SystemProxy
if ($systemProxy) {
    Write-Host "==> Using proxy $systemProxy"
    $env:HTTP_PROXY = $systemProxy
    $env:HTTPS_PROXY = $systemProxy
}

function Stop-WithNodeGuidance([string]$Message) {
    Write-Error "$Message`nInstall Node.js from https://nodejs.org/en/download and run this command again. The Node.js installer includes npm."
    exit 1
}

$script:InlineStatusLength = 0

function Write-InlineStatus([string]$Text) {
    if ($Text.Length -gt 110) { $Text = $Text.Substring(0, 110) }
    $padding = [Math]::Max(0, $script:InlineStatusLength - $Text.Length)
    Write-Host -NoNewline ("`r{0}{1}" -f $Text, (" " * $padding))
    $script:InlineStatusLength = $Text.Length
}

function Clear-InlineStatus {
    if ($script:InlineStatusLength -gt 0) {
        Write-Host -NoNewline ("`r{0}`r" -f (" " * $script:InlineStatusLength))
        $script:InlineStatusLength = 0
    }
}

function Expand-ZipWithProgress([string]$ZipPath, [string]$DestinationPath, [string]$Activity) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
    $total = $zip.Entries.Count
    $done = 0
    $frames = @("|", "/", "-", "\")
    $frameIndex = 0
    $lastRendered = [DateTime]::MinValue
    $fullDest = [System.IO.Path]::GetFullPath($DestinationPath)
    $safePrefix = $fullDest.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    try {
        foreach ($entry in $zip.Entries) {
            $targetPath = [System.IO.Path]::GetFullPath((Join-Path $DestinationPath $entry.FullName))
            if (-not $targetPath.StartsWith($safePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "The archive contains an unsafe path: $($entry.FullName)"
            }
            if ($entry.FullName.EndsWith("/") -or [string]::IsNullOrEmpty($entry.Name)) {
                [System.IO.Directory]::CreateDirectory($targetPath) | Out-Null
            } else {
                $parent = Split-Path -Path $targetPath -Parent
                if (-not (Test-Path -LiteralPath $parent)) {
                    [System.IO.Directory]::CreateDirectory($parent) | Out-Null
                }
                [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $targetPath, $true)
            }
            $done++
            if (((Get-Date) - $lastRendered).TotalMilliseconds -ge 100) {
                $lastRendered = Get-Date
                $pct = if ($total -gt 0) { [int](100 * $done / $total) } else { 100 }
                Write-InlineStatus ("{0}: {1}/{2} files ({3}%) {4}" -f $Activity, $done, $total, $pct, $frames[$frameIndex])
                $frameIndex = ($frameIndex + 1) % $frames.Count
            }
        }
        Clear-InlineStatus
    } finally {
        $zip.Dispose()
    }
}

function Read-WebFileWithProgress([string]$Url, [string]$OutPath, [string]$Activity) {
    # Single-threaded copy loop: no event handlers, which crash Windows
    # PowerShell 5.1 when they fire on .NET thread-pool threads.
    Add-Type -AssemblyName System.Net.Http
    $client = New-Object System.Net.Http.HttpClient
    $client.Timeout = [TimeSpan]::FromMinutes(30)
    $fileStream = $null
    $contentStream = $null
    try {
        $response = $client.GetAsync($Url, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        if (-not $response.IsSuccessStatusCode) {
            throw "Download failed with HTTP $($response.StatusCode): $Url"
        }
        $contentStream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $total = $response.Content.Headers.ContentLength
        $fileStream = [System.IO.File]::Create($OutPath)
        $buffer = New-Object byte[] 81920
        $received = [long]0
        $frames = @("|", "/", "-", "\")
        $frameIndex = 0
        $lastRendered = [DateTime]::MinValue
        while (($read = $contentStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $fileStream.Write($buffer, 0, $read)
            $received += $read
            if (((Get-Date) - $lastRendered).TotalMilliseconds -ge 100) {
                $lastRendered = Get-Date
                if ($total) {
                    $pct = [int](100 * $received / $total)
                    Write-InlineStatus ("{0}: {1:N1} / {2:N1} MB ({3}%) {4}" -f $Activity, ($received / 1MB), ($total / 1MB), $pct, $frames[$frameIndex])
                } else {
                    Write-InlineStatus ("{0}: {1:N1} MB {2}" -f $Activity, ($received / 1MB), $frames[$frameIndex])
                }
                $frameIndex = ($frameIndex + 1) % $frames.Count
            }
        }
        Clear-InlineStatus
    } finally {
        if ($null -ne $fileStream) { $fileStream.Dispose() }
        if ($null -ne $contentStream) { $contentStream.Dispose() }
        $client.Dispose()
    }
}

function Resolve-Executable([string]$CommandName) {
    $cmd = Get-Command $CommandName -ErrorAction SilentlyContinue
    if ($null -eq $cmd) { return $null }
    $source = $cmd.Source
    $ext = [System.IO.Path]::GetExtension($source)
    if ($ext -ne ".cmd" -and $ext -ne ".exe") {
        $candidate = Join-Path (Split-Path -Path $source -Parent) "$CommandName.cmd"
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    return $source
}

function Invoke-WithSpinner {
    param(
        [string]$FilePath,
        [string[]]$ArgumentList = @(),
        [string]$Activity,
        [int]$TimeoutSeconds = 900
    )
    $outLog = [System.IO.Path]::GetTempFileName()
    $errLog = [System.IO.Path]::GetTempFileName()
    $frames = @("|", "/", "-", "\")
    $frameIndex = 0
    $proc = $null
    try {
        # Run through cmd.exe with file redirection: Start-Process on a .cmd
        # child returns an unreliable (often null) ExitCode on Windows
        # PowerShell 5.1, so cmd owns the batch file and the redirection.
        $quotedArgs = ($ArgumentList | ForEach-Object { '"' + ($_ -replace '"', '') + '"' }) -join " "
        $cmdLine = '""{0}" {1} > "{2}" 2> "{3}""' -f $FilePath, $quotedArgs, $outLog, $errLog
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = "cmd.exe"
        $psi.Arguments = "/d /s /c $cmdLine"
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $proc = [System.Diagnostics.Process]::Start($psi)
        $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
        while (-not $proc.HasExited) {
            if ([DateTime]::UtcNow -ge $deadline) { throw "$Activity timed out after $TimeoutSeconds seconds." }
            $frameIndex = ($frameIndex + 1) % $frames.Count
            Write-InlineStatus ("{0}... {1}" -f $Activity, $frames[$frameIndex])
            Start-Sleep -Milliseconds 120
        }
        $proc.WaitForExit()
        $exitCode = $proc.ExitCode
        Clear-InlineStatus
        if ($exitCode -ne 0) {
            Write-Host "==> $FilePath exited with code $exitCode"
            $errText = Get-Content -LiteralPath $errLog -Raw -ErrorAction SilentlyContinue
            if ($errText) { Write-Host $errText.TrimEnd() }
            $outText = Get-Content -LiteralPath $outLog -Raw -ErrorAction SilentlyContinue
            if ($outText) { Write-Host $outText.TrimEnd() }
        }
        return $exitCode
    } finally {
        # A timeout, exception or Ctrl+C must not leave npm/setup descendants
        # running after the installer has released its installation lock.
        if ($null -ne $proc) {
            try {
                if (-not $proc.HasExited) {
                    $killInfo = New-Object System.Diagnostics.ProcessStartInfo
                    $killInfo.FileName = Join-Path $env:WINDIR 'System32\taskkill.exe'
                    $killInfo.Arguments = '/PID ' + $proc.Id + ' /T /F'
                    $killInfo.UseShellExecute = $false
                    $killInfo.CreateNoWindow = $true
                    $killer = [System.Diagnostics.Process]::Start($killInfo)
                    try {
                        if (-not $killer.WaitForExit(10000)) { throw 'Timed out terminating the installer process tree.' }
                        if (-not $proc.WaitForExit(5000)) { throw 'The installer process is still running after cleanup.' }
                    } finally { $killer.Dispose() }
                }
            } finally { $proc.Dispose() }
        }
        Clear-InlineStatus
        Remove-Item -LiteralPath $outLog, $errLog -Force -ErrorAction SilentlyContinue
    }
}

function Test-NodeUsable {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($null -eq $node) { return $false }
    $versionText = (& node --version).Trim()
    $majorText = $versionText.TrimStart("v").Split(".")[0]
    $major = 0
    if (-not [int]::TryParse($majorText, [ref]$major) -or $major -lt $MinimumNodeMajor) { return $false }
    if ($null -eq (Get-Command npm -ErrorAction SilentlyContinue)) { return $false }
    & npm --version *> $null
    return ($LASTEXITCODE -eq 0)
}

function Update-SessionPathFromRegistry {
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machinePath;$userPath"
}

function Test-Elevated {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Install-NodeViaWinget {
    if ($null -eq (Get-Command winget -ErrorAction SilentlyContinue)) { return $false }
    Write-Host "==> Installing Node.js 22 LTS via winget (Windows may show an elevation prompt)"
    & winget install --id OpenJS.NodeJS.LTS --exact --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { return $false }
    Update-SessionPathFromRegistry
    return $true
}

function Install-NodeViaUserZip {
    Write-Host "==> Installing a user-level Node.js 22 runtime under $env:LOCALAPPDATA (no elevation required)"
    $entry = $null
    try {
        Write-Host "==> Checking the latest Node.js $MinimumNodeMajor release"
        $indexCache = Join-Path $env:TEMP "originrouter-node-index.json"
        Read-WebFileWithProgress -Url "https://nodejs.org/dist/index.json" -OutPath $indexCache -Activity "Fetching the Node.js release list"
        $versions = Get-Content -LiteralPath $indexCache -Raw | ConvertFrom-Json
        $entry = $versions | Where-Object { $_.version -like "v$MinimumNodeMajor.*" } | Select-Object -First 1
    } catch {
        return $false
    }
    if ($null -eq $entry) { return $false }
    $version = $entry.version.TrimStart("v")
    $zipName = "node-$($entry.version)-win-x64.zip"
    $zipUrl = "https://nodejs.org/dist/v$version/$zipName"
    $installRoot = Join-Path $env:LOCALAPPDATA "OriginRouter"
    $binDir = Join-Path $installRoot "node-$($entry.version)-win-x64"
    try {
        if (-not (Test-Path -LiteralPath (Join-Path $binDir "node.exe"))) {
            $zipPath = Join-Path $env:TEMP $zipName
            Read-WebFileWithProgress -Url $zipUrl -OutPath $zipPath -Activity "Downloading Node.js v$version"
            Write-Host "==> Extracting Node.js v$version (this may take a minute)"
            Expand-ZipWithProgress -ZipPath $zipPath -DestinationPath $installRoot -Activity "Extracting Node.js v$version"
            Remove-Item $zipPath -Force
        }
    } catch {
        return $false
    }
    if (-not (Test-Path -LiteralPath (Join-Path $binDir "node.exe"))) { return $false }
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if (($null -eq $userPath) -or (-not $userPath.Split(";").Contains($binDir))) {
        [Environment]::SetEnvironmentVariable("Path", "$userPath;$binDir", "User")
    }
    $env:Path = "$binDir;$env:Path"
    return $true
}

# Reuse a Node runtime installed by a previous run of this installer even if
# the current console has not picked up the updated user PATH yet.
$userNodeBins = Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA "OriginRouter") -Directory -Filter "node-*-win-x64" -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^node-v(\d+)\.(\d+)\.(\d+)-win-x64$' } |
    Sort-Object -Property @{ Expression = { [version]($_.Name -replace '^node-v([0-9.]+)-win-x64$', '$1') } } -Descending
foreach ($userNodeBin in $userNodeBins) {
    if ((Test-Path -LiteralPath (Join-Path $userNodeBin.FullName 'node.exe')) -and
        (Test-Path -LiteralPath (Join-Path $userNodeBin.FullName 'npm.cmd'))) {
        $env:Path = "$($userNodeBin.FullName);$env:Path"
        if (Test-NodeUsable) { break }
    }
}

if (-not (Test-NodeUsable)) {
    Write-Host "==> Node.js $MinimumNodeMajor or later with npm was not found."
    $installed = $false
    if (Test-Elevated) {
        $installed = Install-NodeViaWinget
        if (-not $installed) { $installed = Install-NodeViaUserZip }
    } else {
        $installed = Install-NodeViaUserZip
        if (-not $installed) { $installed = Install-NodeViaWinget }
    }
    if (-not $installed -or -not (Test-NodeUsable)) {
        Stop-WithNodeGuidance "Automatic Node.js installation failed."
    }
}

$nodeVersionText = (& node --version).Trim()

$mutex = New-Object System.Threading.Mutex($false, "Local\OriginRouterInstaller")
if (-not $mutex.WaitOne(0)) {
    Write-Error "Another OriginRouter installation is running."
    exit 1
}

try {
    $existing = Get-Command originrouter -ErrorAction SilentlyContinue
    $existingPath = $null
    if ($null -ne $existing) { $existingPath = Resolve-Executable "originrouter" }
    $npmPrefix = (& npm prefix --global).Trim()
    $expectedCommand = Join-Path $npmPrefix "originrouter.cmd"
    $globalPackage = Join-Path ((& npm root --global).Trim()) "@originrouter\cli"
    if (Test-Path -LiteralPath $globalPackage) {
        $packageItem = Get-Item -LiteralPath $globalPackage -Force
        if ($null -ne $packageItem.LinkType) {
            throw "A repository-linked OriginRouter installation was found at $globalPackage. Run npm unlink --global @originrouter/cli before using the official installer."
        }
    }
    if ($null -ne $existingPath -and -not $existingPath.Equals($expectedCommand, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "An OriginRouter command outside the active npm global directory was found at $($existing.Source). Resolve the PATH or installation conflict before continuing."
    }
    if ($null -ne $existing) {
        & npm list --global --depth=0 $PackageName *> $null
        if ($LASTEXITCODE -ne 0) {
            throw "An OriginRouter command managed outside the global npm installation was found at $($existing.Source). Remove the conflicting repository link or installation before continuing."
        }
    }

    $packageSpec = "$PackageName@$Release"
    Write-Host "==> Node.js $nodeVersionText"

    $setupArgs = @()
    if ($Yes) { $setupArgs += "--yes" }
    if ($NoProxy) { $setupArgs += "--no-proxy" }
    if ($DryRun) { $setupArgs += "--dry-run" }

    if ($DryRun) {
        Write-Host "Would run: npm install --global $packageSpec"
        if ($null -ne $existingPath) {
            & $existingPath setup @setupArgs
        } else {
            Write-Host "Would run: originrouter setup --dry-run"
        }
        exit 0
    }

    Write-Host "==> Installing $packageSpec from npm (this may take a few minutes)"
    $npmCommand = Resolve-Executable "npm"
    $installExit = Invoke-WithSpinner -FilePath $npmCommand -ArgumentList @("install", "--global", $packageSpec) -Activity "Installing $packageSpec"
    if ($installExit -ne 0) {
        throw "OriginRouter CLI installation failed. Verify that the npm global directory is writable and that the npm registry is reachable. The installer does not change npm permissions automatically."
    }

    $cliPath = Resolve-Executable "originrouter"
    if ($null -eq $cliPath) {
        $candidate = Join-Path $npmPrefix "originrouter.cmd"
        if (Test-Path -LiteralPath $candidate) {
            $cliPath = $candidate
        } else {
            throw "OriginRouter was installed, but the command could not be found on PATH. Open a new terminal and run this installer again."
        }
    }

    & $cliPath --version
    if ($LASTEXITCODE -ne 0) { throw "The installed OriginRouter command failed verification." }
    Write-Host "==> Preparing the OriginRouter runtime"
    if ($Yes) {
        $setupExit = Invoke-WithSpinner -FilePath $cliPath -ArgumentList (@("setup") + $setupArgs) -Activity "Preparing the OriginRouter runtime" -TimeoutSeconds 1800
        if ($setupExit -ne 0) { throw "OriginRouter setup did not complete successfully. Run the same installer command again to resume." }
    } else {
        & $cliPath setup @setupArgs
        if ($LASTEXITCODE -ne 0) { throw "OriginRouter setup did not complete successfully. Run the same installer command again to resume." }
    }
    Write-Host "==> Verifying the installation"
    & $cliPath setup --verify
    if ($LASTEXITCODE -ne 0) { throw "OriginRouter verification failed. Run the same installer command again to resume." }
    Write-Host "==> OriginRouter installation complete"
}
finally {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
