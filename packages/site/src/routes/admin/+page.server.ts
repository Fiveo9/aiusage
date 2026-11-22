import { error, redirect } from '@sveltejs/kit'
import type { PageServerLoad } from './$types'

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(302, '/login')
  if (locals.user.status === 'banned') throw error(403, 'user_banned')
  if (locals.user.role !== 'admin') throw redirect(302, '/')
}
