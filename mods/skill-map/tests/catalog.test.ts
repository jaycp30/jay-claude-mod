// Unit tests for the pure logic: skill files, merging, grouping, and the
// model's replies, including the bad ones a real model sometimes sends.
import { describe, expect, test } from 'claude-code/testing'

import {
  findDuplicates, fingerprint, groupSkills, mergeSkills, parseFrontmatter, parseOverrides,
  installedQuickButtons, parseQuickButtons, parseSortReply, parseSuggestReply, shortDescription, splitName,
  UNSORTED, withSkill,
} from '../hooks/catalog'
import type { Skill } from '../types'

const skill = (name: string, description = `${name} does things.`, isActive = true): Skill =>
  ({ name, description, sortText: description, provider: 'user', isActive })

describe('frontmatter', () => {
  test('a plain and a quoted value', () => {
    expect(parseFrontmatter('---\nname: tf\ndescription: "Use for Terraform."\n---\n# Body'))
      .toEqual({ name: 'tf', description: 'Use for Terraform.' })
  })
  test('a folded block over several lines', () => {
    const text = '---\nname: qa\ndescription: >\n  Pre-ship audit\n  of an app.\nallowed-tools: Read\n---\n'
    expect(parseFrontmatter(text)).toEqual({ name: 'qa', description: 'Pre-ship audit of an app.' })
  })
  test('no frontmatter at all', () => {
    expect(parseFrontmatter('# Just a heading')).toEqual({})
  })
})

describe('text helpers', () => {
  test('shortDescription keeps the first sentence and cuts long ones', () => {
    expect(shortDescription('Lists things. Then more.')).toBe('Lists things.')
    expect(shortDescription('x'.repeat(200), 20)).toBe(`${'x'.repeat(19)}…`)
  })
  test('fingerprint changes when the description does', () => {
    expect(fingerprint('a')).toBe(fingerprint('a'))
    expect(fingerprint('a')).not.toBe(fingerprint('b'))
  })
})

describe('merging', () => {
  const loaded = [
    { name: 'help', description: 'Help', source: 'builtin' },
    { name: 'compact', description: 'Compact', source: 'builtin' },
    { name: 'qa', description: 'Loaded description.', source: 'user' },
    { name: 'pr:codereview', description: 'Review.', source: 'plugin', plugin: 'pr' },
  ]
  const disk = [
    { name: 'qa', description: 'Disk description.', provider: 'user' },
    { name: 'graphify', description: 'Graph a corpus.', provider: 'user' },
  ]
  const { skills, builtinCount } = mergeSkills(loaded, disk)

  test('built-ins are counted, not listed', () => {
    expect(builtinCount).toBe(2)
    expect(skills.map(s => s.name)).toEqual(['graphify', 'pr:codereview', 'qa'])
  })
  test('a loaded skill shows the session description but sorts on the file', () => {
    expect(skills.find(s => s.name === 'qa')).toEqual({
      name: 'qa', description: 'Loaded description.', sortText: 'Disk description.', provider: 'user', isActive: true,
    })
  })
  test('a skill only on disk is marked not active', () => {
    expect(skills.find(s => s.name === 'graphify')?.isActive).toBe(false)
  })
  test("a plugin's command is credited to the plugin", () => {
    expect(skills.find(s => s.name === 'pr:codereview')?.provider).toBe('pr')
  })
})

describe('grouping', () => {
  const skills = [skill('figma'), skill('terraform-skill'), skill('mystery'), skill('typo')]
  const groups = { figma: 'UI / UX design', 'terraform-skill': 'DevOps & cloud', typo: 'Not a group' }

  test('groups come in the fixed order, Unsorted last', () => {
    expect(groupSkills(skills, groups, '').map(g => [g.name, g.skills.map(s => s.name)])).toEqual([
      ['UI / UX design', ['figma']],
      ['DevOps & cloud', ['terraform-skill']],
      [UNSORTED, ['mystery', 'typo']],
    ])
  })
  test('each group carries its theme colour', () => {
    expect(groupSkills(skills, groups, '')[0]?.color).toBe('bashBorder')
  })
  test('the filter matches name or description, any case', () => {
    expect(groupSkills(skills, groups, 'TERRA').flatMap(g => g.skills.map(s => s.name))).toEqual(['terraform-skill'])
    expect(groupSkills([skill('a', 'Deploys to AWS.')], {}, 'aws')).toHaveLength(1)
  })
})

describe('names', () => {
  test('splitName separates a plugin prefix', () => {
    expect(splitName('anthropic-skills:canvas-design')).toEqual({ prefix: 'anthropic-skills:', base: 'canvas-design' })
    expect(splitName('apple-ui')).toEqual({ prefix: '', base: 'apple-ui' })
  })
  test('findDuplicates pairs the same skill under two prefixes', () => {
    const dupes = findDuplicates([skill('minimalist-ui'), skill('anthropic-skills:minimalist-ui'), skill('apple-ui')])
    expect(dupes.get('minimalist-ui')).toEqual(['anthropic-skills:minimalist-ui'])
    expect(dupes.get('anthropic-skills:minimalist-ui')).toEqual(['minimalist-ui'])
    expect(dupes.has('apple-ui')).toBe(false)
  })
})

describe('clicking a skill', () => {
  const commands = new Set(['qa', 'design-principles'])
  test('an empty box gets the command and a space', () => {
    expect(withSkill('', 'qa', commands)).toBe('/qa ')
    expect(withSkill('   ', 'qa', commands)).toBe('/qa ')
  })
  test('a typed draft is kept after the command', () => {
    expect(withSkill('check the login page', 'qa', commands)).toBe('/qa check the login page')
  })
  test('a draft that starts with a known command has it swapped', () => {
    expect(withSkill('/design-principles the hero', 'qa', commands)).toBe('/qa the hero')
    expect(withSkill('/design-principles', 'qa', commands)).toBe('/qa ')
  })
  test('a draft that starts with a path keeps the path', () => {
    expect(withSkill('/Users/jay/app/main.py throws', 'qa', commands)).toBe('/qa /Users/jay/app/main.py throws')
  })
})

describe('overrides file', () => {
  test('unknown groups and bad JSON are ignored', () => {
    expect(parseOverrides('{"qa": "Code quality & review", "x": "Nope", "y": 3}')).toEqual({ qa: 'Code quality & review' })
    expect(parseOverrides('not json')).toEqual({})
    expect(parseOverrides('["qa"]')).toEqual({})
  })
})

describe("the model's replies", () => {
  test('a sort reply in a code fence is read; strangers are dropped', () => {
    const reply = 'Here you go:\n```json\n{"qa": "Code quality & review", "made-up": "Other", "tf": "Gardening"}\n```'
    expect(parseSortReply(reply, ['qa', 'tf'])).toEqual({ qa: 'Code quality & review' })
  })
  test('a sort reply that is not JSON gives nothing', () => {
    expect(parseSortReply('Sorry, I cannot help with that.', ['qa'])).toEqual({})
  })
  test('suggestions: invented names and duplicates dropped, at most five', () => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f']
    const reply = JSON.stringify([
      { name: 'a', reason: 'r' }, { name: 'ghost', reason: 'r' }, { name: 'a', reason: 'again' },
      { name: 'b' }, { name: 'c' }, { name: 'd' }, { name: 'e' }, { name: 'f' },
    ])
    const picks = parseSuggestReply(reply, names)
    expect(picks.map(p => p.name)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(picks[1]?.reason).toBe('')
  })
  test('a suggestion reply that is not an array gives nothing', () => {
    expect(parseSuggestReply('{"name": "a"}', ['a'])).toEqual([])
  })
})

describe('parseQuickButtons', () => {
  test('reads label=action:skill entries, emoji and plugin names included', () => {
    expect(parseQuickButtons('🧐=run:how-sure, 🙋🏻=type:/humanizer, 📄=type:pdf-viewer:open')).toEqual([
      { label: '🧐', action: 'run', name: 'how-sure' },
      { label: '🙋🏻', action: 'type', name: 'humanizer' },
      { label: '📄', action: 'type', name: 'pdf-viewer:open' },
    ])
  })
  test('skips malformed entries and keeps the rest', () => {
    expect(parseQuickButtons('🧐=launch:how-sure, oops, 🙋🏻=type:humanizer')).toEqual([
      { label: '🙋🏻', action: 'type', name: 'humanizer' },
    ])
    expect(parseQuickButtons('')).toEqual([])
  })
})

describe('installedQuickButtons', () => {
  const buttons = parseQuickButtons('🧐=run:how-sure, 🙋🏻=type:humanizer')
  test('keeps only buttons for skills the session loaded', () => {
    expect(installedQuickButtons(buttons, new Set(['humanizer'])).map(b => b.label)).toEqual(['🙋🏻'])
    expect(installedQuickButtons(buttons, new Set())).toEqual([])
  })
  test('keeps every button when the list could not be read', () => {
    expect(installedQuickButtons(buttons, undefined)).toHaveLength(2)
  })
})
