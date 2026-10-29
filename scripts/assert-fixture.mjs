// This runtime seeds disposable accounts and must never serve production users.
if (process.env.NODE_ENV === 'production') {
  throw new Error(
    'The demo fixture cannot run in production: it resets accounts and data on startup. ' +
    'Use a production backend with persistent accounts and storage.',
  )
}
