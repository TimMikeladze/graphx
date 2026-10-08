/** Hand-placed canvas: one row per route family, starting material left, ibuprofen right. */
export const POS: Record<string, [number, number]> = {
	// main chain
	ibb: [70, 300],
	ibap: [310, 240],
	ibuprofen: [1040, 300],
	// Boots, top row
	B1: [190, 165],
	B2: [385, 95],
	glycidic: [470, 95],
	B3: [555, 95],
	aldehyde: [640, 95],
	B4: [725, 95],
	oxime: [810, 95],
	B5: [895, 95],
	nitrile: [975, 95],
	B6: [1015, 195],
	// BHC, middle row
	H1: [190, 300],
	H2: [460, 300],
	alcohol: [640, 300],
	H3: [840, 300],
	// Flow, bottom row
	F1: [190, 455],
	propio: [380, 470],
	F2: [560, 470],
	ester: [740, 470],
	F3: [900, 470],
	// reagents, next to the step that consumes them
	ac2o: [100, 200],
	clacoet: [330, 35],
	naoet: [445, 30],
	h3o: [555, 30],
	nh2oh: [725, 30],
	h2o: [1075, 150],
	h2: [460, 375],
	co: [840, 375],
	etcooh: [100, 545],
	etcocl: [235, 550],
	piada: [470, 550],
	icl: [560, 555],
	tmof: [650, 550],
	naoh: [900, 545],
};
