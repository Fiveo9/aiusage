const DEVICE_START_PATH = '/api/cli/device/start'
const DEVICE_COMPLETE_PATH = '/api/cli/device/complete'
export interface DeviceStartRequest {
  device_name: string
  cli_version: string
  device_challenge: string
}

export interface DeviceStartResponse {
  device_request_id: string
  user_code: string
  verification_url: string
  expires_at: string
  interval: number
}

export interface DeviceCompleteRequest {
  device_request_id: string
  device_verifier: string
}

export interface DeviceCompleteResponse {
  device_id: string
  device_secret: string
}

export class DeviceAuthApiError extends Error {
  constructor(
    message: string,
    public code?: string,
    public retryAfter?: number
  ) {
    super(message)
    this.name = 'DeviceAuthApiError'
  }
}

async function readJsonOrNull(response: Response): Promise<any | null> {
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('application/json')) return null
  return response.json().catch(() => null)
}

function endpointUnavailableMessage(path: string, status: number): string {
  return `Device authorization endpoint ${path} is unavailable (HTTP ${status}). The site deployment is not routing this API request to the Node server.`
}

export async function startDeviceAuth(
  serverUrl: string,
  request: DeviceStartRequest
): Promise<DeviceStartResponse> {
  const response = await fetch(`${serverUrl}${DEVICE_START_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })

  const data = await readJsonOrNull(response)

  if (!response.ok) {
    throw new DeviceAuthApiError(
      data?.error || endpointUnavailableMessage(DEVICE_START_PATH, response.status),
      data?.error || 'endpoint_unavailable'
    )
  }

  if (!data) {
    throw new DeviceAuthApiError(endpointUnavailableMessage(DEVICE_START_PATH, response.status), 'endpoint_unavailable')
  }

  return data
}

export async function completeDeviceAuth(
  serverUrl: string,
  request: DeviceCompleteRequest
): Promise<DeviceCompleteResponse> {
  const response = await fetch(`${serverUrl}${DEVICE_COMPLETE_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })

  const data = await readJsonOrNull(response)

  if (response.status === 202 || data?.pending) {
    throw new DeviceAuthApiError('Authorization pending', 'authorization_pending')
  }

  if (!response.ok) {
    throw new DeviceAuthApiError(
      data?.error || endpointUnavailableMessage(DEVICE_COMPLETE_PATH, response.status),
      data?.error || 'endpoint_unavailable'
    )
  }

  if (!data) {
    throw new DeviceAuthApiError(endpointUnavailableMessage(DEVICE_COMPLETE_PATH, response.status), 'endpoint_unavailable')
  }

  if (!data.device_id || !data.device_secret) {
    throw new DeviceAuthApiError('Invalid device auth response: missing device credentials', 'invalid_response')
  }

  return data
}

