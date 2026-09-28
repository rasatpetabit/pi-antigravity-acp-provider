// Prints the effective SSL_CERT_FILE it inherited on stderr, then exits.
// stderr is used because the supervisor pipes stdout eagerly and the streamed
// data isn't reliably retained for a synchronous read from the parent after
// the child exits.
process.stderr.write(JSON.stringify({ sslCertFile: process.env.SSL_CERT_FILE ?? null }));
process.exit(0);
