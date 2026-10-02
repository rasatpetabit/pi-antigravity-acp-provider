import { defineConfig } from "vitest/config";

// Tests run against the Pi host that loads this extension, not the package's own devDependency
// copies. Pi's extension loader maps @earendil-works/pi-ai to its compat entry and supplies its
// own typebox, so the tests resolve the same modules.
const PI_HOST = process.env.PI_HOST_ROOT ?? "/srv/pi/releases/6d50b272";
const HOST_MODULES = `${PI_HOST}/node_modules`;

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@earendil-works\/pi-ai$/u, replacement: `${HOST_MODULES}/@earendil-works/pi-ai/dist/compat.js` },
			{ find: /^@earendil-works\/pi-agent-core$/u, replacement: `${HOST_MODULES}/@earendil-works/pi-agent-core/dist/index.js` },
			{ find: /^@earendil-works\/pi-coding-agent$/u, replacement: `${PI_HOST}/dist/index.js` },
			{ find: /^typebox$/u, replacement: `${HOST_MODULES}/typebox/build/index.mjs` },
			{ find: /^typebox\/value$/u, replacement: `${HOST_MODULES}/typebox/build/value/index.mjs` },
		],
	},
	test: {
		include: ["test/**/*.test.ts"],
		testTimeout: 10_000,
	},
});
