import { describe, expect, it } from 'vitest'
import { DeploymentExistsError, DeploymentGateError, DeploymentRegistry, MemoryDeploymentStore } from '@botmesh/deployments'
import {
  FlowDocumentError,
  flowArtifact,
  flowDocumentGate,
  flowFromArtifact,
  flowVersionOf,
  publishFlow,
  type FlowDocument,
} from '../src/index.js'

const valid = (): FlowDocument => ({ version: 1, id: 'sale', trigger: 'sale', steps: [{ kind: 'say', text: 'Hola' }] })

function registry(): DeploymentRegistry {
  return new DeploymentRegistry(new MemoryDeploymentStore(), { clock: () => 1_700_000_000_000 })
}

describe('flow deployment integration', () => {
  it('validates the artifact and reports issues in the gate result', () => {
    const gate = flowDocumentGate()
    const ok = gate({ tenantId: 't', botId: 'b', version: 'v', artifact: flowArtifact(valid()) })
    expect(ok).toMatchObject({ ok: true })
    expect(ok.summary).toMatch(/sale/)
    const bad = gate({ tenantId: 't', botId: 'b', version: 'v', artifact: '{"version":1,"id":"x","trigger":"x","steps":[{"kind":"nope"}]}' })
    expect(bad.ok).toBe(false)
    expect(bad.reason).toMatch(/must be one of/)
    expect(bad.details).toMatchObject({ issues: expect.any(Array) })
  })

  it('parses an artifact and rejects invalid JSON or documents', () => {
    expect(flowFromArtifact(flowArtifact(valid()))).toEqual(valid())
    expect(() => flowFromArtifact('{')).toThrow(FlowDocumentError)
    expect(() => flowFromArtifact('{"version":1}')).toThrow(FlowDocumentError)
  })

  it('publishes a valid document, activates it and is idempotent per draft', async () => {
    const deployments = registry()
    const deployment = await publishFlow(deployments, 'acme', 'support', valid())
    expect(deployment).toMatchObject({ tenantId: 'acme', botId: 'support', version: flowVersionOf(valid()), active: true })
    expect(deployment.gate).toMatchObject({ passed: true })
    expect(flowFromArtifact(deployment.artifact)).toEqual(valid())
    expect((await deployments.active('acme', 'support'))?.version).toBe(deployment.version)
    await expect(publishFlow(deployments, 'acme', 'support', valid())).rejects.toBeInstanceOf(DeploymentExistsError)
    expect(await deployments.gateRuns('acme', 'support', deployment.version)).toHaveLength(1)
  })

  it('refuses an invalid document before touching the registry', async () => {
    const deployments = registry()
    const bad = { version: 1, id: 'x', trigger: 'x', steps: [{ kind: 'say' }] } as unknown as FlowDocument
    await expect(publishFlow(deployments, 'acme', 'support', bad, { version: 'draft-1' })).rejects.toBeInstanceOf(FlowDocumentError)
    expect(await deployments.active('acme', 'support')).toBeUndefined()
    expect(await deployments.gateRuns('acme', 'support', 'draft-1')).toEqual([])
  })

  it('runs an extra gate after the document check', async () => {
    const deployments = registry()
    const deployment = await publishFlow(deployments, 'acme', 'support', valid(), {
      version: 'with-extra',
      gate: () => ({ ok: true, summary: 'extra' }),
    })
    expect(deployment.version).toBe('with-extra')
    const failed = await publishFlow(deployments, 'acme', 'other', valid(), { version: 'fails', gate: () => ({ ok: false, reason: 'nope' }) })
      .then(() => 'ok', (error: Error) => error)
    expect(failed).toBeInstanceOf(DeploymentGateError)
    expect((failed as DeploymentGateError).result.reason).toBe('nope')
  })
})
