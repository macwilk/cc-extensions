// What the mod learns without asking a model: a check that failed or passed, and a question dialog
// that was left with questions unanswered. Nothing here touches the engine.
import type { Item } from '../types'

type Fields = Pick<Item, 'kind' | 'title' | 'from' | 'why' | 'close'> & Partial<Item>
type Asked = { question: string; header?: string; multiSelect?: boolean; options?: { label: string; description?: string }[] }

/** Commands whose exit status says whether the work holds: tests, type checks, linters, builds, validators. */
const CHECKS = [
  /^(npm|pnpm|yarn|bun) (run )?(test|lint|typecheck|type-check|check|build)\b/,
  /^(npx|pnpm dlx|bunx) (-p \S+ )?(tsc|vitest|jest|eslint|biome|prettier --check|playwright test)\b/,
  /^(tsc|vitest|jest|eslint|biome|ruff|mypy|pyright|pytest|flake8)\b/,
  /^(uv run |poetry run |python3? -m )(pytest|mypy|ruff|unittest)\b/,
  /^(go|cargo) (test|vet|build|check|clippy)\b/,
  /^make (test|check|lint|build)\b/,
  /^(terraform|tofu) (validate|plan)\b/,
  /^claude plugin (validate|test)\b/,
]

/**
 * The command as a check's name, or null when it is not one. A command joined to another by a pipe,
 * `&&`, `||` or `;` is not one either: its exit status is then not the check's own. Moving to a
 * folder first is the one exception, since the status is still the check's.
 */
export function checkOf(command: string) {
  const line = command.trim().replace(/\s+/g, ' ')
  const inPlace = line.replace(/^(cd \S+ ?(&&|;) ?)+/, '')
  if (/[|;]|&&/.test(inPlace.replace(/2>&1/g, ''))) return null
  const run = inPlace.replace(/^(cd \S+ )?/, '').replace(/^([A-Z_]+=\S+ )+/, '')

  return CHECKS.some(check => check.test(run)) ? line : null
}

/**
 * What a check is known by, so that a passing rerun closes it: its name less the env vars set before
 * its command, a `2>&1` of its own, and how it moves to a folder, none of which change what runs or
 * what passing means. The folder stays, as a check in another folder is another check.
 */
export function checkKey(check: string) {
  const moves = /^(cd \S+ ?(&&|;) ?)*/.exec(check)?.[0] ?? ''
  const folders = [...moves.matchAll(/cd (\S+?) ?(?:&&|;)/g)].map(move => `cd ${move[1]} && `).join('')
  const run = check.slice(moves.length).replace(/^([A-Z_]+=\S+ )+/, '').replace(/ 2>&1(?= |$)/g, '')

  return `${folders}${run}`.trim()
}

/** A failed check as a new item: what failed, the end of what it printed, and how it closes. */
export function failedCheck(command: string, output: string): Fields {
  const lines = output
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  const name = command.replace(/^(npx|pnpm dlx|bunx) (-p \S+ )?/, '').slice(0, 60)

  return {
    kind: 'check',
    title: `Failed: ${name}`,
    from: `The command itself: ${command} ended with an error.`,
    why: lines.slice(-4).join(' ').slice(0, 400) || 'It printed nothing.',
    close: 'A fix, and a run of the same check that passes.',
    command,
    key: checkKey(command),
    selfCloses: 'When the same check next runs and passes.',
  }
}

/**
 * The questions of a dialog the person left, each as a new item with its own answers. `reply` is
 * what the dialog handed back to Claude. Where it names the questions, the ones marked as having
 * no answer are the ones left; a dialog refused with no such list left all of them. A dialog that
 * was answered gives none.
 */
export function leftQuestions(asked: Asked[], reply: string, isRefused: boolean, dialog: string, time: string): Fields[] {
  if (!isRefused) return []
  const isListed = reply.includes('Questions asked:')
  const left = asked.filter(one => {
    const at = reply.indexOf(`"${one.question}"`)

    return !isListed || (at >= 0 && reply.slice(at + one.question.length + 2, at + one.question.length + 40).includes('(No answer provided)'))
  })

  return left.map(one => {
    const options = (one.options ?? []).map(option => option.label.replace(/\s*\(Recommended\)\s*$/i, ''))
    const recommended = (one.options ?? []).flatMap((option, at) => (/\(Recommended\)\s*$/i.test(option.label) ? [at] : []))
    const described = (one.options ?? []).filter(option => option.description).map(option => `${option.label.replace(/\s*\(Recommended\)\s*$/i, '')}: ${option.description}`)

    return {
      kind: 'question' as const,
      title: one.question,
      from: `A question dialog of Claude's at ${time} with ${asked.length} ${asked.length === 1 ? 'question' : 'questions'}, which was left before this one was answered.`,
      why: described.join(' ') || 'Claude asked, and the work may be waiting on the answer.',
      close: one.multiSelect ? 'Tick every answer that applies.' : 'Pick one of the answers.',
      dialog,
      ...(options.length > 0 ? { options } : {}),
      ...(one.multiSelect ? { isMulti: true as const } : {}),
      ...(recommended.length > 0 ? { recommended } : {}),
    }
  })
}
