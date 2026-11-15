import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const sourceFile = ts.createSourceFile(
  'app.ts',
  readFileSync(new URL('./app.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
)

function findUpdaterCalls(target: string): ts.CallExpression[] {
  const calls: ts.CallExpression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(sourceFile) === target) {
      calls.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return calls
}

function hasWindowsGuard(node: ts.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (
      ts.isIfStatement(current) &&
      current.expression.getText(sourceFile).includes("process.platform === 'win32'")
    ) {
      return true
    }
  }
  return false
}

describe('electron-updater feed isolation', () => {
  it('configures the generic NSIS feed only on Windows', () => {
    const calls = findUpdaterCalls('autoUpdater.setFeedURL')

    expect(calls).toHaveLength(1)
    expect(calls.every(hasWindowsGuard)).toBe(true)
  })

  it('never queries electron-updater from Linux or macOS', () => {
    const calls = findUpdaterCalls('autoUpdater.checkForUpdates')

    expect(calls).toHaveLength(3)
    expect(calls.every(hasWindowsGuard)).toBe(true)
  })
})
