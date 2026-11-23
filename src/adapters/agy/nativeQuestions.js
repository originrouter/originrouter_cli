export function agyQuestions(args) {
  let questions = args?.questions;
  if (typeof questions === 'string') {
    if (questions.length > 64000) return null;
    try { questions = JSON.parse(questions); } catch { return null; }
  }
  if (!Array.isArray(questions) || !questions.length || questions.length > 4) return null;
  if (questions.some(q => !q || typeof q.question !== 'string' || q.question.length > 2048 || !Array.isArray(q.options)
      || !q.options.length || q.options.length > 8 || q.options.some(o => typeof o !== 'string' || o.length > 256))) return null;
  return questions.map((q, i) => ({ id: `q${i + 1}`, header: `Question ${i + 1}`,
    question: q.question.slice(0, 2048), multiple: q.is_multi_select === true, allow_other: q.is_multi_select !== true,
    options: q.options.map((label, j) => ({ id: `o${j + 1}`, label: label.slice(0, 256), description: '' })) }));
}

// This is a view of the current terminal screen, never a search of old output.
export function questionPanel(screen) {
  const match = [...screen.matchAll(/^\s*Question (\d+)\/(\d+):[ \t]*([^\n]*)/gm)].at(-1);
  if (!match) return null;
  const options = [...screen.slice(match.index + match[0].length).matchAll(/^\s*([>❯]?)\s*(\d+)\.\s*(?:\[([ xX✓])\]\s*)?([^\n]+)/gm)]
    .map(m => ({ index: Number(m[2]) - 1, cursor: Boolean(m[1]), checked: /[xX✓]/.test(m[3] || ''), label: m[4].trim() }));
  return { number: Number(match[1]), total: Number(match[2]), question: match[3].trim(), options };
}

export function questionSelection(question, raw) {
  const values = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  if (!values.length || (!question.multiple && values.length !== 1)) throw new Error('invalid_question_answer');
  const indices = [], other = [];
  for (const value of values) {
    const text = String(value);
    const index = question.options.findIndex(o => o.label === text);
    if (index >= 0) indices.push(index); else other.push(text);
  }
  if (other.length > 1 || other.some(x => !x || x.length > 2048 || /[\x00-\x1f\x7f]/.test(x))) throw new Error('invalid_question_answer');
  // Native mixed custom + multi selections do not have a verified responder contract.
  if (other.length && question.multiple) throw new Error('multi_select_custom_answer_unavailable');
  return { indices: [...new Set(indices)], other: other[0] || null };
}
