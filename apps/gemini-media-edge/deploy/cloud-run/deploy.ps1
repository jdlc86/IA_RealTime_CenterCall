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
  [string]$Service = 'gemini-media-edge',

  [ValidatePattern('^[A-Za-z0-9._-]+$')]
  [string]$ImageTag = 'canary',

  [string]$TtsVoiceName = 'es-ES-Standard-H'
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
if (-not $gcloud) {
  throw 'Google Cloud CLI (gcloud) is required. Install it and run gcloud auth login first.'
}

function Invoke-Gcloud {
  param([Parameter(Mandatory = $true)][string[]]$GcloudArgs)
  & $gcloud @GcloudArgs
  if ($LASTEXITCODE -ne 0) {
    throw "gcloud failed: $($GcloudArgs -join ' ')"
  }
}

$sourceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$serviceAccount = "gemini-media-edge@$ProjectId.iam.gserviceaccount.com"
$taggedImage = "$Region-docker.pkg.dev/$ProjectId/$Repository/$Service`:$ImageTag"

Invoke-Gcloud @(
  'builds', 'submit', $sourceRoot,
  '--tag', $taggedImage,
  '--region', $Region,
  '--project', $ProjectId,
  '--suppress-logs'
)

$digest = (& $gcloud artifacts docker images describe $taggedImage --project $ProjectId --format 'value(image_summary.digest)').Trim()
if ($LASTEXITCODE -ne 0 -or $digest -notmatch '^sha256:[a-f0-9]{64}$') {
  throw 'Cloud Build completed but an immutable Artifact Registry digest could not be resolved.'
}
$imageWithoutTag = $taggedImage.Substring(0, $taggedImage.LastIndexOf(':'))
$immutableImage = "$imageWithoutTag@$digest"

$environment = @(
  'MEDIA_EDGE_SINGLE_INSTANCE=true',
  'MEDIA_EDGE_PUBLIC_URL=wss://bootstrap.invalid/telnyx/gemini',
  "GOOGLE_CLOUD_PROJECT_ID=$ProjectId",
  'GOOGLE_SPEECH_LOCATION=global',
  'GOOGLE_SPEECH_RECOGNIZER=_',
  'GOOGLE_SPEECH_MODEL=telephony_short',
  'GOOGLE_SPEECH_LANGUAGE_CODES=es-ES',
  'GOOGLE_TTS_LANGUAGE_CODE=es-ES',
  "GOOGLE_TTS_VOICE_NAME=$TtsVoiceName",
  'MEDIA_EDGE_VAD_START_RMS=0.2',
  'MEDIA_EDGE_VAD_STOP_RMS=0.05',
  'MEDIA_EDGE_VAD_MIN_SPEECH_MS=40',
  'MEDIA_EDGE_VAD_MIN_SILENCE_MS=160'
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
  '--memory', '2Gi',
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
  throw 'Cloud Run deployed but its HTTPS service URL could not be resolved.'
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
  singleInstanceCanary = $true
  requestTimeoutSeconds = 3600
} | ConvertTo-Json -Depth 3
