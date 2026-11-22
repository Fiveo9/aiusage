import bcrypt from 'bcryptjs'
import { getConfigValue, CFG } from '$lib/server/config.js'
import { error } from '@sveltejs/kit'

const SALT_ROUNDS = 12
export const DUMMY_PASSWORD_HASH = bcrypt.hashSync('authentication-timing-placeholder', SALT_ROUNDS)
export const MAX_PASSWORD_BYTES = 72

export function passwordInputError(password: unknown): ValidationError {
  if (typeof password !== 'string') return { code: 'password_type' }
  if (password.length > 128 || Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    return { code: 'password_too_long', params: { max: MAX_PASSWORD_BYTES } }
  }
  return null
}

export async function hashPassword(password: string): Promise<string> {
  const inputError = passwordInputError(password)
  if (inputError) throw error(400, inputError.code)
  return bcrypt.hash(password, SALT_ROUNDS)
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (passwordInputError(password) || typeof hash !== 'string') return false
  return bcrypt.compare(password, hash)
}

export type ValidationError = { code: string; params?: Record<string, number> } | null

export async function validateUsername(username: string): Promise<ValidationError> {
  const minLen = await getConfigValue(CFG.USERNAME_MIN_LENGTH)
  const maxLen = await getConfigValue(CFG.USERNAME_MAX_LENGTH)
  if (!username || username.length < minLen || username.length > maxLen) {
    return { code: 'username_length', params: { min: minLen, max: maxLen } }
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    return { code: 'username_chars' }
  }
  return null
}

export function validateEmail(email: string): ValidationError {
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { code: 'invalid_email' }
  }
  return null
}

export async function validatePassword(password: unknown): Promise<ValidationError> {
  const inputError = passwordInputError(password)
  if (inputError) return inputError
  const value = password as string
  const minLen = await getConfigValue(CFG.PASSWORD_MIN_LENGTH)
  if (!value || value.length < minLen) {
    return { code: 'password_length', params: { min: minLen } }
  }
  return null
}
