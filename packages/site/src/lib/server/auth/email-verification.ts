import { createHash } from 'node:crypto'
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'
import { Resend } from 'resend'
import { env } from '$env/dynamic/private'
import { nanoid } from 'nanoid'
import { sql } from '$lib/server/db/pool.js'
import { getConfigValue, CFG } from '$lib/server/config.js'
import { wrapBrandedEmail } from './email-template.js'
import { hashIp } from '../crypto/hmac.js'

const PURPOSE = 'email_verification'

let sesClient: SESv2Client | null = null
let resendClient: Resend | null = null

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function hashValue(value: string): string {
  return hashIp(value)
}

function getSiteUrl(): string {
  return (env.SITE_URL || 'http://localhost:5173').replace(/\/+$/, '')
}

function getSesClient(): SESv2Client {
  if (!sesClient) {
    sesClient = new SESv2Client({
      region: env.AWS_SES_REGION || 'us-west-2',
      credentials: env.AWS_SES_ACCESS_KEY_ID && env.AWS_SES_SECRET_ACCESS_KEY
        ? {
            accessKeyId: env.AWS_SES_ACCESS_KEY_ID,
            secretAccessKey: env.AWS_SES_SECRET_ACCESS_KEY
          }
        : undefined
    })
  }
  return sesClient
}

function hasSesConfig(): boolean {
  return env.EMAIL_PROVIDER === 'ses' && Boolean(env.AWS_SES_ACCESS_KEY_ID && env.AWS_SES_SECRET_ACCESS_KEY)
}

function getResendClient(): Resend {
  if (!resendClient) {
    resendClient = new Resend(env.RESEND_API_KEY)
  }
  return resendClient
}

function hasResendConfig(): boolean {
  return env.EMAIL_PROVIDER === 'resend' && Boolean(env.RESEND_API_KEY)
}

export async function createEmailVerification(userId: string, email: string): Promise<string> {
  return (await createEmailVerificationWithPolling(userId, email)).url
}

export async function createEmailVerificationWithPolling(userId: string, email: string): Promise<{ url: string; pollToken: string }> {
  const tokenTtlHours = await getConfigValue(CFG.EMAIL_TOKEN_TTL_HOURS)
  const token = nanoid(48)
  // Independent of the email token: this only permits status polling.
  const pollToken = nanoid(48)
  const expiresAt = new Date(Date.now() + tokenTtlHours * 60 * 60 * 1000)

  await sql`
    INSERT INTO email_verification_tokens (id, user_id, email, token_hash, expires_at)
    VALUES (${pollToken}, ${userId}, ${email.toLowerCase()}, ${hashToken(token)}, ${expiresAt})
  `

  return { url: `${getSiteUrl()}/verify-email?token=${encodeURIComponent(token)}`, pollToken }
}

export async function checkVerificationEmailRateLimit(ip: string, email: string): Promise<{ code: string } | null> {
  const [
    ipLimitWindowMinutes,
    ipLimit,
    emailLimitWindowHours,
    emailLimit,
    globalLimitWindowHours,
    globalLimit
  ] = await Promise.all([
    getConfigValue(CFG.EMAIL_IP_LIMIT_WINDOW_MINUTES),
    getConfigValue(CFG.EMAIL_IP_LIMIT),
    getConfigValue(CFG.EMAIL_LIMIT_WINDOW_HOURS),
    getConfigValue(CFG.EMAIL_LIMIT),
    getConfigValue(CFG.EMAIL_GLOBAL_LIMIT_WINDOW_HOURS),
    getConfigValue(CFG.EMAIL_GLOBAL_LIMIT)
  ])

  const ipHash = hashValue(ip)
  const emailHash = hashValue(email.toLowerCase())

  return sql.begin(async (tx) => {
  // Serialize count-and-reserve, including the global limit, across processes.
  await tx`SELECT pg_advisory_xact_lock(hashtext(${`email-send:${PURPOSE}`}))`

  const [ipRows, emailRows, globalRows] = await Promise.all([
    tx`
      SELECT COUNT(*)::INTEGER AS count
      FROM email_send_attempts
      WHERE purpose = ${PURPOSE}
        AND ip_hash = ${ipHash}
        AND created_at > NOW() - (${`${ipLimitWindowMinutes} minutes`})::INTERVAL
    `,
    tx`
      SELECT COUNT(*)::INTEGER AS count
      FROM email_send_attempts
      WHERE purpose = ${PURPOSE}
        AND email_hash = ${emailHash}
        AND created_at > NOW() - (${`${emailLimitWindowHours} hours`})::INTERVAL
    `,
    tx`
      SELECT COUNT(*)::INTEGER AS count
      FROM email_send_attempts
      WHERE purpose = ${PURPOSE}
        AND created_at > NOW() - (${`${globalLimitWindowHours} hours`})::INTERVAL
    `
  ])

  if (Number(ipRows[0]?.count || 0) >= ipLimit) {
    return { code: 'rate_limit_ip' }
  }
  if (Number(emailRows[0]?.count || 0) >= emailLimit) {
    return { code: 'rate_limit_email' }
  }
  if (Number(globalRows[0]?.count || 0) >= globalLimit) {
    return { code: 'rate_limit_global' }
  }

  await tx`INSERT INTO email_send_attempts (id, purpose, ip_hash, email_hash)
    VALUES (${nanoid()}, ${PURPOSE}, ${ipHash}, ${emailHash})`
  return null
  })
}

export async function recordVerificationEmailAttempt(ip: string, email: string): Promise<void> {

  await sql`
    INSERT INTO email_send_attempts (id, purpose, ip_hash, email_hash)
    VALUES (${nanoid()}, ${PURPOSE}, ${hashValue(ip)}, ${hashValue(email)})
  `

}

export async function sendVerificationEmail(email: string, username: string, verificationUrl: string): Promise<void> {
  const tokenTtlHours = await getConfigValue(CFG.EMAIL_TOKEN_TTL_HOURS)

  const subject = 'Verify your AIUsage email'
  const text = [
    `Hi ${username},`,
    '',
    'Open this link to verify your AIUsage email address:',
    verificationUrl,
    '',
    `This link expires in ${tokenTtlHours} hours.`
  ].join('\n')

  const html = wrapBrandedEmail({
    title: 'Verify Your Email',
    preheader: `Hi ${escapeHtml(username)}, verify your AIUsage email address to get started.`,
    greeting: `Hi ${escapeHtml(username)},`,
    bodyHtml: `Thanks for signing up for AIUsage. Click the button below to verify your email address and activate your account.`,
    button: { label: 'Verify Email Address', url: verificationUrl },
    footerHtml: `This link expires in <strong>${tokenTtlHours} hours</strong>. If you didn't create an account, you can safely ignore this email.`
  })

  if (hasSesConfig()) {
    await getSesClient().send(new SendEmailCommand({
      FromEmailAddress: env.EMAIL_FROM || 'AIUsage <noreply@jtanx.com>',
      Destination: {
        ToAddresses: [email]
      },
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: {
            Text: { Data: text, Charset: 'UTF-8' },
            Html: { Data: html, Charset: 'UTF-8' }
          }
        }
      }
    }))
    return
  }

  if (hasResendConfig()) {
    const { error } = await getResendClient().emails.send({
      from: env.EMAIL_FROM || 'AIUsage <noreply@aiusage.jtanx.com>',
      to: email,
      subject,
      text,
      html
    })
    if (error) {
      throw new Error(`Resend error: ${error.message}`)
    }
    return
  }

  if (!env.EMAIL_WEBHOOK_URL) {
    throw new Error('Email delivery is not configured')
  }

  const response = await fetch(env.EMAIL_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      to: email,
      from: env.EMAIL_FROM || 'AIUsage <noreply@aiusage.local>',
      subject,
      text,
      html
    })
  })

  if (!response.ok) {
    throw new Error(`Email webhook failed: ${response.status}`)
  }
}

export async function consumeEmailVerificationToken(token: string): Promise<{ userId: string; email: string } | null> {
  const rows = await sql.begin(async (tx) => {
    const candidates = await tx`SELECT user_id FROM email_verification_tokens WHERE token_hash = ${hashToken(token)}`
    if (!candidates[0]) return []
    // The owner lock must precede token locks, including sibling tokens.
    await tx`SELECT id FROM users WHERE id = ${candidates[0].user_id as string} FOR UPDATE`
    const matches = await tx`
      SELECT id, user_id, email
      FROM email_verification_tokens
      WHERE token_hash = ${hashToken(token)}
        AND consumed_at IS NULL
        AND expires_at > clock_timestamp()
      FOR UPDATE
    `
    const match = matches[0] as { id: string; user_id: string; email: string } | undefined
    if (!match) return []

    const updated = await tx`UPDATE users SET email_verified = TRUE, updated_at = NOW()
      WHERE id = ${match.user_id} AND LOWER(email) = LOWER(${match.email}) RETURNING id`
    if (!updated.length) return []
    await tx`UPDATE email_verification_tokens SET consumed_at = NOW() WHERE id = ${match.id}`
    await tx`UPDATE email_verification_tokens SET consumed_at = NOW() WHERE user_id = ${match.user_id} AND consumed_at IS NULL`

    return [{ userId: match.user_id, email: match.email }]
  })

  return rows[0] || null
}

// ── Password Reset ──

const RESET_PURPOSE = 'password_reset'

export async function createPasswordResetToken(userId: string): Promise<string> {
  const tokenTtlHours = await getConfigValue(CFG.EMAIL_TOKEN_TTL_HOURS)
  const token = nanoid(48)
  const expiresAt = new Date(Date.now() + tokenTtlHours * 60 * 60 * 1000)

  await sql`
    INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at)
    VALUES (${nanoid()}, ${userId}, ${hashToken(token)}, ${expiresAt})
  `

  return `${getSiteUrl()}/reset-password?token=${encodeURIComponent(token)}`
}

export async function checkPasswordResetRateLimit(ip: string, email: string): Promise<{ code: string } | null> {
  const [
    ipLimitWindowMinutes,
    ipLimit,
    emailLimitWindowHours,
    emailLimit,
  ] = await Promise.all([
    getConfigValue(CFG.EMAIL_IP_LIMIT_WINDOW_MINUTES),
    getConfigValue(CFG.EMAIL_IP_LIMIT),
    getConfigValue(CFG.EMAIL_LIMIT_WINDOW_HOURS),
    getConfigValue(CFG.EMAIL_LIMIT),
  ])

  const ipHash = hashValue(ip)
  const emailHash = hashValue(email.toLowerCase())

  return sql.begin(async (tx) => {
  await tx`SELECT pg_advisory_xact_lock(hashtext(${`email-send:${RESET_PURPOSE}`}))`

  const [ipRows, emailRows] = await Promise.all([
    tx`
      SELECT COUNT(*)::INTEGER AS count
      FROM email_send_attempts
      WHERE purpose = ${RESET_PURPOSE}
        AND ip_hash = ${ipHash}
        AND created_at > NOW() - (${`${ipLimitWindowMinutes} minutes`})::INTERVAL
    `,
    tx`
      SELECT COUNT(*)::INTEGER AS count
      FROM email_send_attempts
      WHERE purpose = ${RESET_PURPOSE}
        AND email_hash = ${emailHash}
        AND created_at > NOW() - (${`${emailLimitWindowHours} hours`})::INTERVAL
    `,
  ])

  if (Number(ipRows[0]?.count || 0) >= ipLimit) {
    return { code: 'rate_limit_ip' }
  }
  if (Number(emailRows[0]?.count || 0) >= emailLimit) {
    return { code: 'rate_limit_email' }
  }

  await tx`INSERT INTO email_send_attempts (id, purpose, ip_hash, email_hash)
    VALUES (${nanoid()}, ${RESET_PURPOSE}, ${ipHash}, ${emailHash})`
  return null
  })
}

export async function recordPasswordResetAttempt(ip: string, email: string): Promise<void> {
  await sql`
    INSERT INTO email_send_attempts (id, purpose, ip_hash, email_hash)
    VALUES (${nanoid()}, ${RESET_PURPOSE}, ${hashValue(ip)}, ${hashValue(email)})
  `
}

export async function sendPasswordResetEmail(email: string, username: string, resetUrl: string): Promise<void> {
  const tokenTtlHours = await getConfigValue(CFG.EMAIL_TOKEN_TTL_HOURS)

  const subject = 'Reset your AIUsage password'
  const text = [
    `Hi ${username},`,
    '',
    'Open this link to reset your AIUsage password:',
    resetUrl,
    '',
    `This link expires in ${tokenTtlHours} hours.`,
    '',
    'If you did not request this, you can safely ignore this email.'
  ].join('\n')

  const html = wrapBrandedEmail({
    title: 'Reset Your Password',
    preheader: `Hi ${escapeHtml(username)}, reset your AIUsage password.`,
    greeting: `Hi ${escapeHtml(username)},`,
    bodyHtml: `We received a request to reset the password for your AIUsage account. Click the button below to set a new password.`,
    button: { label: 'Reset Password', url: resetUrl },
    footerHtml: `This link expires in <strong>${tokenTtlHours} hours</strong>. If you didn't request a password reset, you can safely ignore this email — your password will remain unchanged.`
  })

  if (hasSesConfig()) {
    await getSesClient().send(new SendEmailCommand({
      FromEmailAddress: env.EMAIL_FROM || 'AIUsage <noreply@jtanx.com>',
      Destination: { ToAddresses: [email] },
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: {
            Text: { Data: text, Charset: 'UTF-8' },
            Html: { Data: html, Charset: 'UTF-8' }
          }
        }
      }
    }))
    return
  }

  if (hasResendConfig()) {
    const { error } = await getResendClient().emails.send({
      from: env.EMAIL_FROM || 'AIUsage <noreply@aiusage.jtanx.com>',
      to: email,
      subject,
      text,
      html
    })
    if (error) throw new Error(`Resend error: ${error.message}`)
    return
  }

  if (!env.EMAIL_WEBHOOK_URL) {
    throw new Error('Email delivery is not configured')
  }

  const response = await fetch(env.EMAIL_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      to: email,
      from: env.EMAIL_FROM || 'AIUsage <noreply@aiusage.local>',
      subject,
      text,
      html
    })
  })

  if (!response.ok) {
    throw new Error(`Email webhook failed: ${response.status}`)
  }
}

export async function consumePasswordResetToken(token: string, passwordHash?: string | (() => Promise<string>)): Promise<{ userId: string } | null> {
  const rows = await sql.begin(async (tx) => {
    const candidates = await tx`SELECT user_id FROM password_reset_tokens WHERE token_hash = ${hashToken(token)}`
    if (!candidates[0]) return []
    await tx`SELECT id FROM users WHERE id = ${candidates[0].user_id as string} FOR UPDATE`
    const matches = await tx`
      SELECT id, user_id
      FROM password_reset_tokens
      WHERE token_hash = ${hashToken(token)}
        AND consumed_at IS NULL
        AND expires_at > clock_timestamp()
      FOR UPDATE
    `
    const match = matches[0] as { id: string; user_id: string } | undefined
    if (!match) return []

    if (passwordHash !== undefined) {
      // Do bcrypt only after a live token was found, without consuming it
      // before the password and session updates can commit together.
      const newHash = typeof passwordHash === 'function' ? await passwordHash() : passwordHash
      await tx`UPDATE users SET password_hash = ${newHash}, updated_at = NOW() WHERE id = ${match.user_id}`
      await tx`DELETE FROM sessions WHERE user_id = ${match.user_id}`
    }

    // Consume this token and invalidate all other pending tokens for this user
    await tx`UPDATE password_reset_tokens SET consumed_at = NOW() WHERE id = ${match.id}`
    await tx`UPDATE password_reset_tokens SET consumed_at = NOW() WHERE user_id = ${match.user_id} AND consumed_at IS NULL`

    return [{ userId: match.user_id }]
  })

  return rows[0] || null
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
