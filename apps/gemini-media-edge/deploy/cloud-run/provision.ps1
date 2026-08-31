[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-z][a-z0-9-]{4,28}[a-z0-9]$')]
  [string]$ProjectId,

  [ValidatePattern('^[a-z]+-[a-z]+[0-9]+$')]
  [string]$Region = 'europe-west9',

  [ValidatePattern('^[a-z][a-z0-9-]{0,62}$')]
  [string]$Repository = 'ia-realtime-centercall',

  [ValidatePattern('^[a-z][a-z0-9-]{0,28}[a-z0-9]$')]
  [string]$ServiceAccountName = 'gemini-media-edge'
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

Invoke-Gcloud @('config', 'set', 'project', $ProjectId)
Invoke-Gcloud @(
  'services', 'enable',
  'run.googleapis.com',
  'artifactregistry.googleapis.com',
  'cloudbuild.googleapis.com',
  'secretmanager.googleapis.com',
  'apikeys.googleapis.com',
  'generativelanguage.googleapis.com',
  'speech.googleapis.com',
  'texttospeech.googleapis.com',
  '--project', $ProjectId
)

& $gcloud artifacts repositories describe $Repository --location $Region --project $ProjectId *> $null
if ($LASTEXITCODE -ne 0) {
  Invoke-Gcloud @(
    'artifacts', 'repositories', 'create', $Repository,
    '--repository-format', 'docker',
    '--location', $Region,
    '--description', 'IA RealTime CenterCall container images',
    '--project', $ProjectId
  )
}

$serviceAccount = "$ServiceAccountName@$ProjectId.iam.gserviceaccount.com"
& $gcloud iam service-accounts describe $serviceAccount --project $ProjectId *> $null
if ($LASTEXITCODE -ne 0) {
  Invoke-Gcloud @(
    'iam', 'service-accounts', 'create', $ServiceAccountName,
    '--display-name', 'Gemini media edge Cloud Run identity',
    '--project', $ProjectId
  )
}

foreach ($role in @('roles/speech.client', 'roles/serviceusage.serviceUsageConsumer')) {
  Invoke-Gcloud @(
    'projects', 'add-iam-policy-binding', $ProjectId,
    '--member', "serviceAccount:$serviceAccount",
    '--role', $role,
    '--condition', 'None',
    '--quiet'
  )
}

$secretNames = @(
  'gemini-media-edge-gemini-api-key',
  'gemini-media-edge-credential-hmac-secret',
  'gemini-media-edge-control-plane-token'
)
foreach ($secretName in $secretNames) {
  & $gcloud secrets describe $secretName --project $ProjectId *> $null
  if ($LASTEXITCODE -ne 0) {
    Invoke-Gcloud @('secrets', 'create', $secretName, '--replication-policy', 'automatic', '--project', $ProjectId)
  }
  Invoke-Gcloud @(
    'secrets', 'add-iam-policy-binding', $secretName,
    '--member', "serviceAccount:$serviceAccount",
    '--role', 'roles/secretmanager.secretAccessor',
    '--project', $ProjectId,
    '--quiet'
  )
}

$buildServiceAccount = (& $gcloud builds get-default-service-account --project $ProjectId 2>$null).Trim()
if ($LASTEXITCODE -eq 0 -and $buildServiceAccount) {
  Invoke-Gcloud @(
    'projects', 'add-iam-policy-binding', $ProjectId,
    '--member', "serviceAccount:$buildServiceAccount",
    '--role', 'roles/artifactregistry.writer',
    '--condition', 'None',
    '--quiet'
  )
}

[pscustomobject]@{
  projectId = $ProjectId
  region = $Region
  repository = $Repository
  serviceAccount = $serviceAccount
  secretsCreatedWithoutValues = $secretNames
} | ConvertTo-Json -Depth 3
