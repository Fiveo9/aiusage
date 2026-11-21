import { clearCredentials, hasCredentials } from '../device-auth/credentials.js'

export async function runLogout(): Promise<void> {
  if (!hasCredentials()) {
    console.log('Not logged in to the cloud sync.')
    return
  }

  clearCredentials()
  console.log('✓ Logged out from the cloud sync. Local credentials cleared.')
  console.log('Note: Your device authorization is still valid on the server.')
  console.log('To fully revoke the device, visit the settings page on the website.')
}
