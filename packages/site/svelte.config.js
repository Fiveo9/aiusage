import adapter from '@sveltejs/adapter-node'

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    adapter: adapter({
      out: 'build'
    }),
    env: {
      // Local qualification never consumes real deployment credentials.
      dir: process.env.AIUSAGE_LOCAL_CHECK_ROOT ? `${process.env.AIUSAGE_LOCAL_CHECK_ROOT}/env` : '.'
    }
  }
}

export default config
