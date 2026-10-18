import { defineGraphSchema } from 'graphx/core';
import { z } from 'zod';
export const formats = [
	'commander',
	'modern',
	'standard',
	'pioneer',
	'legacy',
	'vintage',
	'pauper',
] as const;
export const faceSchema = z.object({
	name: z.string(),
	manaCost: z.string(),
	manaValue: z.number(),
	type: z.string(),
	text: z.string(),
	power: z.string().optional(),
	toughness: z.string().optional(),
	loyalty: z.string().optional(),
	side: z.string().optional(),
});
export const cardSchema = z.object({
	id: z.string(),
	name: z.string(),
	asciiName: z.string(),
	aliases: z.array(z.string()).default([]),
	manaCost: z.string(),
	manaValue: z.number(),
	type: z.string(),
	types: z.array(z.string()),
	subtypes: z.array(z.string()),
	supertypes: z.array(z.string()),
	text: z.string(),
	colors: z.array(z.string()),
	colorIdentity: z.array(z.string()),
	keywords: z.array(z.string()),
	printings: z.array(z.string()),
	legalities: z.record(z.string(), z.string()),
	faces: z.array(faceSchema),
	rulings: z.array(z.object({ date: z.string(), text: z.string() })),
	scryfallId: z.string().optional(),
	prices: z
		.object({
			usd: z.string().nullable(),
			eur: z.string().nullable(),
			asOf: z.string(),
			source: z.literal('Scryfall'),
		})
		.optional(),
	edhrecRank: z.number().optional(),
	leadershipSkills: z.record(z.string(), z.boolean()).optional(),
	hasAlternativeDeckLimit: z.boolean().optional(),
	isGameChanger: z.boolean().optional(),
	layout: z.string(),
});
export const entrySchema = z.object({
	cardId: z.string().min(1),
	quantity: z.number().int().min(1).max(999),
	board: z.enum(['main', 'side', 'maybe']),
});
export const deckSchema = z
	.object({
		name: z.string().trim().min(1).max(120),
		format: z.enum(formats),
		entries: z.array(entrySchema).max(1000),
		commanderId: z.string().nullable().default(null),
	})
	.superRefine((d, c) => {
		if (d.format !== 'commander' && d.commanderId)
			c.addIssue({ code: 'custom', message: 'Commander is only supported in Commander format' });
		const keys = d.entries.map((e) => `${e.board}:${e.cardId}`);
		if (new Set(keys).size !== keys.length)
			c.addIssue({ code: 'custom', message: 'Duplicate card/board entries' });
		if (d.entries.reduce((n, e) => n + e.quantity, 0) > 2000)
			c.addIssue({ code: 'custom', message: 'Deck exceeds 2000 cards' });
	});
const named = z.object({ name: z.string() });
export const schema = defineGraphSchema({
	nodes: {
		card: cardSchema,
		keyword: named,
		subtype: named,
		color: named,
		format: named,
		set: z.looseObject({ name: z.string() }),
		published_deck: z.looseObject({ name: z.string(), sourceId: z.string() }),
		role: named,
		deck: deckSchema,
		dataset: z.object({
			name: z.string(),
			date: z.string(),
			version: z.string(),
			coverage: z.string(),
			cards: z.number(),
			source: z.string(),
		}),
	},
	edges: {
		has_keyword: { from: 'card', to: 'keyword' },
		has_subtype: { from: 'card', to: 'subtype' },
		has_color: { from: 'card', to: 'color' },
		legal_in: { from: 'card', to: 'format', data: z.object({ status: z.string() }) },
		printed_in: { from: 'card', to: 'set' },
		fills_role: {
			from: 'card',
			to: 'role',
			data: z.object({ evidence: z.string(), ruleVersion: z.number() }),
		},
		related_to: { from: 'card', to: 'card' },
		published_in: { from: 'published_deck', to: 'set' },
		published_contains: {
			from: 'published_deck',
			to: 'card',
			data: z.object({ quantity: z.number().int().positive(), board: z.string() }),
		},
		contains: {
			from: 'deck',
			to: 'card',
			data: z.object({
				quantity: z.number().int().positive(),
				board: z.enum(['main', 'side', 'maybe']),
			}),
		},
	},
});
export type Card = z.infer<typeof cardSchema>;
export type Deck = z.infer<typeof deckSchema>;
export type DeckRecord = Deck & { id: string; revision: string };
export type Entry = z.infer<typeof entrySchema>;
