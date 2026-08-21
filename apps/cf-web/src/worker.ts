/** Placeholder Worker entry until the Host Durable Object lands. */
export default {
  fetch(): Response {
    return new Response('dsh-cf-web: not assembled yet', { status: 503 })
  },
}
