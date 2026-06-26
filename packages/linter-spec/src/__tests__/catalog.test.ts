import { allDetectors, detectors, detectorsByGroup } from '#root/catalog'
import { DETECTOR_IDS } from '#root/detector-ids'
import { DETECTOR_GROUPS, DetectorGroup } from '#root/groups'
import { backendLayerModel, frontendSegmentModel, infraKitSegmentModel, layerModels, segmentModels } from '#root/layers'
import { SEVERITIES } from '#root/severity'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Count TypeScript SYNTAX errors in a standalone snippet (no type-checking). */
function syntaxErrorCount(code: string): number {
  const out = ts.transpileModule(code, {
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ESNext,
      isolatedModules: true,
    },
  })

  return (out.diagnostics ?? []).filter((d) => {
    return d.category === ts.DiagnosticCategory.Error
  }).length
}

describe('catalog integrity', () => {
  it('defines at least 39 concrete detectors', () => {
    expect(allDetectors.length).toBeGreaterThanOrEqual(39)
  })

  it('has unique, kebab-case ids', () => {
    const ids = allDetectors.map((d) => {
      return d.id
    })

    expect(new Set(ids).size).toBe(ids.length)

    for (const id of ids) {
      expect(id, `id "${id}" is not kebab-case`).toMatch(KEBAB)
    }
  })

  it('exposes DETECTOR_IDS as a no-duplicate bijection with the live detector ids', () => {
    expect(new Set(DETECTOR_IDS).size).toBe(DETECTOR_IDS.length)

    const liveIdList = allDetectors.map((d) => {
      return d.id
    })
    const liveIds = new Set<string>(liveIdList)
    const declaredIds = new Set<string>(DETECTOR_IDS)

    const staleDeclared = [...declaredIds].filter((id) => {
      return !liveIds.has(id)
    })
    const undeclaredLive = [...liveIds].filter((id) => {
      return !declaredIds.has(id)
    })

    // Every declared id is live (no stale entry) and every live id is declared (union complete).
    expect(staleDeclared, 'declared ids with no detector').toEqual([])
    expect(undeclaredLive, 'detector ids missing from DETECTOR_IDS').toEqual([])
  })

  it('every detector belongs to a known group', () => {
    for (const d of allDetectors) {
      expect(DETECTOR_GROUPS, `${d.id} has unknown group ${d.group}`).toContain(d.group)
    }
  })

  it('detectorsByGroup covers every detector exactly once', () => {
    const grouped = DETECTOR_GROUPS.flatMap((g) => {
      return detectorsByGroup[g]
    })

    expect(grouped).toHaveLength(allDetectors.length)
    const uniqueGroupedIds = new Set(
      grouped.map((d) => {
        return d.id
      }),
    )

    expect(uniqueGroupedIds.size).toBe(allDetectors.length)
  })

  it('detectors lookup is keyed by id and complete', () => {
    expect(Object.keys(detectors)).toHaveLength(allDetectors.length)
    for (const d of allDetectors) {
      expect(detectors[d.id]).toBe(d)
    }
  })

  it('every detector uses a valid default severity', () => {
    for (const d of allDetectors) {
      expect(SEVERITIES, `${d.id} severity`).toContain(d.defaultSeverity)
    }
  })
})

describe('detector fields', () => {
  it('every detector has at least one non-empty bad/good example', () => {
    for (const d of allDetectors) {
      expect(d.examples.length, `${d.id} has no examples`).toBeGreaterThanOrEqual(1)
      for (const ex of d.examples) {
        expect(ex.bad.trim(), `${d.id} bad example empty`).not.toBe('')
        expect(ex.good.trim(), `${d.id} good example empty`).not.toBe('')
      }
    }
  })

  it('enforces the scope/eslint invariant (eslint seam only for file scope)', () => {
    for (const d of allDetectors) {
      if (d.scope === 'file') {
        expect(d.eslint, `${d.id} (file) must have an eslint seam`).toBeTruthy()
        expect(typeof d.eslint.messageId).toBe('string')
      } else {
        // project/graph detectors may not carry an eslint seam.
        expect(d.eslint ?? null, `${d.id} (${d.scope}) must NOT have an eslint seam`).toBeNull()
      }
    }
  })

  it('every detector records existing-coverage status', () => {
    const valid = ['covered', 'partial', 'none']

    for (const d of allDetectors) {
      expect(d.existing, `${d.id} missing existing-coverage`).toBeDefined()
      expect(valid, `${d.id} existing.status`).toContain(d.existing?.status)
    }
  })

  it('enabledInRepo:false detectors name the dormant rule (plugin + rule + note)', () => {
    for (const d of allDetectors) {
      if (d.existing?.enabledInRepo === false) {
        expect(d.existing.plugin?.trim(), `${d.id} enabledInRepo:false needs a plugin`).toBeTruthy()
        expect(d.existing.rule?.trim(), `${d.id} enabledInRepo:false needs a rule`).toBeTruthy()
        expect(d.existing.note?.trim(), `${d.id} enabledInRepo:false needs a note`).toBeTruthy()
        // A dormant rule enforces nothing, so it must read as a gap.
        expect(d.existing.status, `${d.id} enabledInRepo:false must be status:'none'`).toBe('none')
      }
    }
  })

  it('ai-agentic detectors are measurable (concrete option) or proposed', () => {
    const measurableTypes = ['number', 'enum', 'string[]']
    const aiAgentic = allDetectors.filter((d) => {
      return d.group === DetectorGroup.aiAgentic
    })

    expect(aiAgentic.length).toBeGreaterThan(0)

    for (const d of aiAgentic) {
      if (d.status === 'proposed') {
        continue
      }

      const hasConcreteOption = (d.options ?? []).some((o) => {
        return measurableTypes.includes(o.type)
      })

      expect(hasConcreteOption, `${d.id} must have a number/enum/string[] option or be 'proposed'`).toBe(true)
    }
  })
})

describe('examples are syntactically valid TypeScript (anti-rot)', () => {
  it('every good example transpiles with no syntax errors', () => {
    for (const d of allDetectors) {
      d.examples.forEach((ex, i) => {
        expect(syntaxErrorCount(ex.good), `${d.id} good example #${i} has syntax errors`).toBe(0)
      })
    }
  })

  it('every bad example parses (transpiles without throwing)', () => {
    for (const d of allDetectors) {
      d.examples.forEach((ex, i) => {
        expect(() => {
          return ts.transpileModule(ex.bad, { compilerOptions: { isolatedModules: true } })
        }, `${d.id} bad example #${i}`).not.toThrow()
      })
    }
  })
})

describe('layer / segment models', () => {
  it('models have ordered, non-duplicate layers', () => {
    for (const model of segmentModels) {
      const names = model.layers.map((l) => {
        return l.name
      })
      const orders = model.layers.map((l) => {
        return l.order
      })

      expect(new Set(names).size, `${model.id} duplicate layer names`).toBe(names.length)
      expect(new Set(orders).size, `${model.id} duplicate orders`).toBe(orders.length)
      expect(model.layers.length).toBeGreaterThanOrEqual(2)
    }
  })

  it('ships generic templates plus the concrete infra-kit instance', () => {
    expect(layerModels).toContain(backendLayerModel)
    expect(layerModels).toContain(frontendSegmentModel)
    expect(backendLayerModel.generic).toBe(true)
    expect(frontendSegmentModel.generic).toBe(true)
    expect(infraKitSegmentModel.generic).toBe(false)
  })

  it('generic templates contain no infra-kit-specific layer names', () => {
    const infraNames = new Set(
      infraKitSegmentModel.layers.map((l) => {
        return l.name
      }),
    )

    for (const model of layerModels) {
      for (const layer of model.layers) {
        expect(infraNames.has(layer.name), `${model.id} leaks infra-kit name "${layer.name}"`).toBe(false)
      }
    }
  })
})
