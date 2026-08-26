[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-z][a-z0-9-]{4,28}[a-z0-9]$')]
  [string]$ProjectId,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[1-9][0-9]*$')]
  [string]$GeminiApiKeySecretVersion,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[1-9][0-9]*$')]
  [string]$CredentialSecretVersion,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[1-9][0-9]*$')]
  [string]$ControlTokenSecretVersion,

  [ValidatePattern('^[a-z]+-[a-z]+[0-9]+$')]
  [string]$Region = 'europe-west9',

  [ValidatePattern('^[a-z][a-z0-9-]{0,62}$')]
  [string]$Repository = 'ia-realtime-centercall',

  [ValidatePattern('^[a-z][a-z0-9-]{0,62}$')]
  [string]$Service = 'gemini-media-edge-fast',

  [ValidatePattern('^[A-Za-z0-9._-]+$')]
  [string]$ImageTag = 'canary'
)

$ErrorActionPreference = 'Stop'

function Resolve-Gcloud {
  $command = Get-Command gcloud -ErrorAction SilentlyContinue
  if ($null -ne $command) { return $command.Source }
  $userInstall = Join-Path $env:LOCALAPPDATA 'Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd'
  if (Test-Path -LiteralPath $userInstall) { return $userInstall }
  return $null
}

$gcloud = Resolve-Gcloud
if (-not $gcloud) { throw 'Google Cloud CLI (gcloud) is required.' }

function Invoke-Gcloud {
  param([Parameter(Mandatory = $true)][string[]]$GcloudArgs)
  & $gcloud @GcloudArgs
  if ($LASTEXITCODE -ne 0) { throw "gcloud failed: $($GcloudArgs -join ' ')" }
}

$sourceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$cloudBuildConfig = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'cloudbuild-fast.yaml')).Path
$serviceAccount = "gemini-media-edge@$ProjectId.iam.gserviceaccount.com"
$taggedImage = "$Region-docker.pkg.dev/$ProjectId/$Repository/$Service`:$ImageTag"

$buildId = (& $gcloud builds submit $sourceRoot `
  --config $cloudBuildConfig `
  --substitutions "_IMAGE=$taggedImage" `
  --region $Region `
  --project $ProjectId `
  --async `
  --suppress-logs `
  --format 'value(id)').Trim()
if ($LASTEXITCODE -ne 0 -or $buildId -notmatch '^[0-9a-fA-F-]{36}$') {
  throw 'Fast Cloud Build could not be submitted or its build id could not be resolved.'
}

$buildDeadline = (Get-Date).AddMinutes(20)
do {
  $buildStatus = (& $gcloud builds describe $buildId `
    --region $Region `
    --project $ProjectId `
    --format 'value(status)').Trim()
  if ($LASTEXITCODE -ne 0) { throw "Fast Cloud Build status could not be read for build $buildId." }
  switch ($buildStatus) {
    'SUCCESS' { break }
    'FAILURE' { throw "Fast Cloud Build $buildId failed." }
    'INTERNAL_ERROR' { throw "Fast Cloud Build $buildId ended with INTERNAL_ERROR." }
    'TIMEOUT' { throw "Fast Cloud Build $buildId timed out." }
    'CANCELLED' { throw "Fast Cloud Build $buildId was cancelled." }
    'EXPIRED' { throw "Fast Cloud Build $buildId expired." }
    'QUEUED' { Start-Sleep -Seconds 5 }
    'PENDING' { Start-Sleep -Seconds 5 }
    'WORKING' { Start-Sleep -Seconds 5 }
    default { throw "Fast Cloud Build $buildId returned unexpected status '$buildStatus'." }
  }
  if ((Get-Date) -gt $buildDeadline) { throw "Timed out waiting for Fast Cloud Build $buildId." }
} while ($buildStatus -ne 'SUCCESS')

$digest = (& $gcloud artifacts docker images describe $taggedImage --project $ProjectId --format 'value(image_summary.digest)').Trim()
if ($LASTEXITCODE -ne 0 -or $digest -notmatch '^sha256:[a-f0-9]{64}$') {
  throw 'Fast Cloud Build completed but immutable image digest could not be resolved.'
}
$imageWithoutTag = $taggedImage.Substring(0, $taggedImage.LastIndexOf(':'))
$immutableImage = "$imageWithoutTag@$digest"

$environment = @(
  'MEDIA_EDGE_SINGLE_INSTANCE=true',
  'MEDIA_EDGE_PUBLIC_URL=wss://bootstrap.invalid/telnyx/gemini',
  'GEMINI_LIVE_MODEL=gemini-3.1-flash-live-preview',
  'GEMINI_LIVE_VOICE=Kore'
) -join ','

$secrets = @(
  "GEMINI_API_KEY=gemini-media-edge-gemini-api-key:$GeminiApiKeySecretVersion",
  "MEDIA_EDGE_CREDENTIAL_HMAC_SECRET=gemini-media-edge-credential-hmac-secret:$CredentialSecretVersion",
  "MEDIA_EDGE_CONTROL_PLANE_TOKEN=gemini-media-edge-control-plane-token:$ControlTokenSecretVersion"
) -join ','

Invoke-Gcloud @(
  'run', 'deploy', $Service,
  '--project', $ProjectId,
  '--region', $Region,
  '--image', $immutableImage,
  '--service-account', $serviceAccount,
  '--execution-environment', 'gen2',
  '--port', '8080',
  '--cpu', '1',
  '--memory', '512Mi',
  '--concurrency', '25',
  '--min-instances', '1',
  '--max-instances', '1',
  '--timeout', '3600',
  '--set-env-vars', $environment,
  '--set-secrets', $secrets,
  '--allow-unauthenticated',
  '--quiet'
)

$serviceUrl = (& $gcloud run services describe $Service --project $ProjectId --region $Region --format 'value(status.url)').Trim()
if ($LASTEXITCODE -ne 0 -or $serviceUrl -notmatch '^https://') {
  throw 'Fast Cloud Run deployed but its HTTPS service URL could not be resolved.'
}
$publicWebSocketUrl = "wss://$(([uri]$serviceUrl).Host)/telnyx/gemini"
Invoke-Gcloud @(
  'run', 'services', 'update', $Service,
  '--project', $ProjectId,
  '--region', $Region,
  '--update-env-vars', "MEDIA_EDGE_PUBLIC_URL=$publicWebSocketUrl",
  '--quiet'
)

[pscustomobject]@{
  projectId = $ProjectId
  region = $Region
  service = $Service
  image = $immutableImage
  serviceUrl = $serviceUrl
  publicWebSocketUrl = $publicWebSocketUrl
  buildId = $buildId
  model = 'gemini-3.1-flash-live-preview'
  singleInstanceCanary = $true
  requestTimeoutSeconds = 3600
} | ConvertTo-Json -Depth 3
