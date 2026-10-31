import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  apply,
  edgeHostToolCatalog,
  executeEdgeHostTool,
  validateEdgeHostToolArgs,
} from './edge'

test('host catalog and Cordis registrations come from the same tool definitions', () => {
  const registrations: Array<{ name: string; schema: any }> = []
  apply({
    Tool: (_namespace: string, name: string, _executor: unknown, schema: any) => {
      registrations.push({ name, schema })
    },
  } as any)

  assert.deepEqual(
    registrations.map((registration) => registration.name),
    edgeHostToolCatalog.tools.map((tool) => tool.name),
  )

  for (const tool of edgeHostToolCatalog.tools) {
    const registration = registrations.find((item) => item.name === tool.name)
    assert.ok(registration)
    assert.equal(registration.schema.meta.description, tool.description)
    assert.deepEqual(Object.keys(registration.schema.dict || {}), Object.keys(tool.inputSchema.properties))
    assert.equal(tool.inputSchema.additionalProperties, false)

    for (const [name, jsonSchema] of Object.entries(tool.inputSchema.properties) as [string, any][]) {
      const schema = registration.schema.dict[name]
      assert.equal(schema.meta.description, jsonSchema.description)
      assert.equal(Boolean(schema.meta.required), tool.inputSchema.required?.includes(name) ?? false)
      if (jsonSchema.enum) {
        assert.equal(schema.type, 'union')
        const serialized = schema.toJSON()
        const root = serialized.refs[String(serialized.uid)]
        const values = root.list.map((ref: number) => serialized.refs[String(ref)].value)
        assert.deepEqual(values, jsonSchema.enum)
      } else {
        assert.equal(schema.type, jsonSchema.type)
      }
    }
  }
})

test('host argument validation is strict and normalizes Edge tool arguments', () => {
  assert.deepEqual(validateEdgeHostToolArgs('edge_status', {}), {})
  assert.deepEqual(validateEdgeHostToolArgs('edge_list_devices', { nodeId: ' node-1 ' }), { nodeId: 'node-1' })
  assert.deepEqual(validateEdgeHostToolArgs('zigbee_control_device', {
    nodeId: ' node-1 ',
    deviceId: ' lamp ',
    state: ' toggle ',
  }), { nodeId: 'node-1', deviceId: 'lamp', state: 'TOGGLE' })

  assert.throws(() => validateEdgeHostToolArgs('edge_list_devices', {}), /nodeId is required/)
  assert.throws(() => validateEdgeHostToolArgs('edge_status', { unexpected: true }), /Unexpected argument/)
  assert.throws(() => validateEdgeHostToolArgs('zigbee_control_device', {
    nodeId: 'node-1',
    deviceId: 'lamp',
    state: 'UNKNOWN',
  }), /state must be ON, OFF, or TOGGLE/)
  assert.throws(() => validateEdgeHostToolArgs('unknown_tool', {}), /Unknown Edge tool/)
})

test('host tool dispatcher invokes the shared Edge implementation', () => {
  const result = executeEdgeHostTool('edge_status') as { mode: string; nodeCount: number }
  assert.equal(result.mode, 'edge')
  assert.equal(typeof result.nodeCount, 'number')
})
