import type { Jev, JevQuestion } from '../../src/jev/index.ts';

export type Asked = { state: any; questions: Record<string, JevQuestion> };

/**
 * A Jev stand-in. `answer(id, question, state)` returns the value for one question — a noul's
 * probability, a choice's option, or a score — and the stub builds the typed answer around it.
 * Unanswered: noul 0, the first option, score 0.
 */
export function fakeJev(
	answer: (id: string, q: JevQuestion, state: any) => number | string | undefined = () => undefined,
	opts: { confidence?: number } = {},
) {
	const asked: Asked[] = [];
	const jev = {
		model: 'jev-latest',
		ask: async (state: any, questions: Record<string, JevQuestion>) => {
			asked.push({ state, questions });
			const answers: Record<string, unknown> = {};
			for (const [id, q] of Object.entries(questions)) {
				const v = answer(id, q, state);
				if (q.type === 'noul') answers[id] = { type: 'noul', noul: (v as number) ?? 0 };
				else if (q.type === 'choice') {
					const options = Object.keys(q.criteria);
					const pick = (v as string) ?? options[0];
					answers[id] = {
						type: 'choice',
						choice: pick,
						probabilities: Object.fromEntries(
							options.map((o) => [o, o === pick ? 0.9 : 0.1 / (options.length - 1)]),
						),
						confidence: opts.confidence ?? 0.8,
					};
				} else {
					answers[id] = {
						type: 'score',
						score: (v as number) ?? 0,
						legend: {},
						probabilities: {},
						confidence: 0.8,
					};
				}
			}
			return { model: 'jev-1.13.0', answers, usage: { input_tokens: 10, output_tokens: 0 } };
		},
	} as unknown as Jev;
	return { jev, asked };
}
