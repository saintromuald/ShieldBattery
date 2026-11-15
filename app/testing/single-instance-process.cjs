// Runs the real single-instance implementation under Node with only Electron's app API stubbed.
'use strict'

const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')

const stateDirectory = process.env.SB_TEST_STATE_DIR
const role = process.argv[2]
if (!stateDirectory || !role) {
  throw new Error('SB_TEST_STATE_DIR and a process role are required')
}

const statePath = name => path.join(stateDirectory, name)
const app = {
  name: 'HyperShield',
  quit: () => {
    fs.writeFileSync(statePath(`${role}.quit`), '')
    process.exit(0)
  },
}
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return { app, dialog: { showErrorBox: () => {} } }
  }
  return originalLoad.call(this, request, parent, isMain)
}

require('../single-instance.ts').default(async () => {
  fs.writeFileSync(statePath(`${role}.loaded`), '')
  return notification => {
    fs.writeFileSync(statePath('notification.json'), JSON.stringify(notification))
  }
})

setTimeout(() => {
  console.error(`single-instance ${role} process timed out`)
  process.exit(2)
}, 8_000)
