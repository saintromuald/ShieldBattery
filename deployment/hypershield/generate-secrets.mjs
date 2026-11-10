#!/usr/bin/env node
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const domain = (process.argv[2] ?? '').toLowerCase().replace(/\.$/, '')
if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
  console.error(`Usage: node ${process.argv[1]} your-domain.example`)
  console.error('Run on the deployment host. Existing .env files are never overwritten.')
  process.exit(2)
}

const appDir = join(root, 'appserver')
const coordinatorDir = join(root, 'coordinator')
const appEnvPath = join(appDir, '.env')
const coordinatorEnvPath = join(coordinatorDir, '.env')

function assertAbsent(path) {
  try {
    readFileSync(path)
    throw new Error(`${path} already exists; refusing to overwrite it`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

assertAbsent(appEnvPath)
assertAbsent(coordinatorEnvPath)

function replaceAssignment(text, name, value) {
  const pattern = new RegExp(`^${name}=.*$`, 'm')
  if (!pattern.test(text)) throw new Error(`Missing ${name} in environment template`)
  return text.replace(pattern, `${name}=${value}`)
}

function prepare(templatePath) {
  return readFileSync(templatePath, 'utf8').replaceAll('hypershield.example', domain)
}

let appEnv = prepare(join(appDir, 'sample.env'))
let coordinatorEnv = prepare(join(coordinatorDir, 'sample.env'))
for (const name of ['POSTGRES_SUPER_PASSWORD', 'SB_DB_PASSWORD']) {
  appEnv = replaceAssignment(appEnv, name, randomBytes(32).toString('hex'))
}
appEnv = replaceAssignment(appEnv, 'SB_JWT_SECRET', randomBytes(48).toString('base64url'))

const seedFromPkcs8 = der => der.subarray(16)
const rawFromSpki = der => der.subarray(12)
function pkcs8V2(seed, publicKey) {
  return Buffer.concat([
    Buffer.from([0x30, 0x53]),
    Buffer.from([0x02, 0x01, 0x01]),
    Buffer.from([0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70]),
    Buffer.from([0x04, 0x22, 0x04, 0x20]),
    seed,
    Buffer.from([0xa1, 0x23, 0x03, 0x21, 0x00]),
    publicKey,
  ])
}

const signing = generateKeyPairSync('ed25519')
const signingSeed = seedFromPkcs8(signing.privateKey.export({ type: 'pkcs8', format: 'der' }))
const signingPublicKey = rawFromSpki(signing.publicKey.export({ type: 'spki', format: 'der' }))
coordinatorEnv = replaceAssignment(
  coordinatorEnv,
  'COORDINATOR_TENANT_HYPERSHIELD_SIGNING_KEY',
  pkcs8V2(signingSeed, signingPublicKey).toString('base64'),
)
coordinatorEnv = replaceAssignment(
  coordinatorEnv,
  'COORDINATOR_BOOTSTRAP_SECRET',
  randomBytes(32).toString('hex'),
)

const client = generateKeyPairSync('ed25519')
const clientSeed = seedFromPkcs8(client.privateKey.export({ type: 'pkcs8', format: 'der' }))
const clientPublicKey = rawFromSpki(client.publicKey.export({ type: 'spki', format: 'der' }))
appEnv = replaceAssignment(appEnv, 'SB_RP2_CLIENT_KEY', clientSeed.toString('hex'))

const tenantsPath = join(coordinatorDir, 'config', 'tenants.json')
const tenants = JSON.parse(readFileSync(tenantsPath, 'utf8'))
if (tenants.tenants?.length !== 1 || tenants.tenants[0].id !== 'hypershield') {
  throw new Error('Expected exactly one HyperShield tenant in config/tenants.json')
}
tenants.tenants[0]['client_pubkeys'] = [clientPublicKey.toString('hex')]
tenants.tenants[0]['notify_url'] = `https://play.${domain}/webhooks/netcode-v2/game-events`

writeFileSync(appEnvPath, appEnv, { mode: 0o600, flag: 'wx' })
writeFileSync(coordinatorEnvPath, coordinatorEnv, { mode: 0o600, flag: 'wx' })
writeFileSync(tenantsPath, `${JSON.stringify(tenants, null, 2)}\n`)

console.log(`Generated HyperShield secrets for ${domain}.`)
console.log(`Wrote permission-restricted files: ${appEnvPath} and ${coordinatorEnvPath}`)
console.log('Secret values were not printed. Back up these files securely.')
console.log('Still required privately: Mailgun, Spaces, and AWS credentials.')
console.log('Create coordinator/data owned by container UID/GID 65532 before starting it.')
