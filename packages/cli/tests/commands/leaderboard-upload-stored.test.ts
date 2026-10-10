import { describe, it, expect } from 'vitest'
import { wasLeaderboardUploadStored } from '../../src/commands/leaderboard-upload.js'

describe('wasLeaderboardUploadStored', () => {
  it('is false when there was no usage to upload', () => {
    expect(wasLeaderboardUploadStored({ totalTokens: 0, response: null })).toBe(false)
  })

  it('is false when the site rejected the request, as it does when rate limited', () => {
    expect(wasLeaderboardUploadStored({
      totalTokens: 100,
      response: { request_id: '', status: 'rejected', snapshots: [] },
    })).toBe(false)
  })

  it('is true for an accepted or a flagged upload', () => {
    for (const status of ['accepted', 'flagged']) {
      expect(wasLeaderboardUploadStored({
        totalTokens: 100,
        response: { request_id: 'r1', status, snapshots: [] },
      })).toBe(true)
    }
  })
})
