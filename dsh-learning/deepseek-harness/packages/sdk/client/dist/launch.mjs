import { dirname, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
//#region lib/types/launch.js
/**
* Resolve the public SDK launch configuration to one dsh subprocess.
* @module @deepseek-ai/dsh-sdk-client/launch
*/
/** Default bound for a profile to answer the SDK initialize handshake. */
const DEFAULT_INITIALIZE_TIMEOUT_MS = 1e4;
/** Read a package manifest from one resolved package.json URL. */
function manifest(url) {
	return JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
}
/**
* Resolve and version-check a dsh executable from package manifests.
* @param dshManifestUrl - resolved URL of the dsh package manifest.
* @param clientManifestUrl - resolved URL of the SDK client manifest.
* @returns the absolute dsh executable path.
*/
function resolveDshBinFromManifests(dshManifestUrl, clientManifestUrl) {
	const dshManifest = manifest(dshManifestUrl);
	const clientManifest = manifest(clientManifestUrl);
	if (typeof dshManifest.version !== "string" || dshManifest.version !== clientManifest.version) throw new Error(`dsh SDK client ${String(clientManifest.version)} requires the same dsh version, got ${String(dshManifest.version)}`);
	const bin = typeof dshManifest.bin === "object" && dshManifest.bin !== null ? dshManifest.bin.dsh : dshManifest.bin;
	if (typeof bin !== "string" || bin === "") throw new Error("@deepseek-ai/dsh declares no dsh executable");
	return resolve(dirname(fileURLToPath(dshManifestUrl)), bin);
}
/**
* Resolve and version-check the built dsh executable installed with this SDK.
* @returns the absolute built executable path, whether or not it exists in a source checkout.
*/
function installedDshBin() {
	return resolveDshBinFromManifests(import.meta.resolve("@deepseek-ai/dsh/package.json"), new URL("../package.json", import.meta.url).href);
}
/**
* Resolve the Node launch for one same-version dsh package.
* @param dshManifestUrl - resolved URL of the dsh package manifest.
* @param clientManifestUrl - resolved URL of the SDK client manifest.
* @param sourceLoaderUrl - optional absolute tsx loader URL for deterministic tests.
* @returns built output, or the source entry plus its compatibility patch and tsx environment.
*/
function resolveDshNodeLaunchFromManifests(dshManifestUrl, clientManifestUrl, sourceLoaderUrl) {
	const bin = resolveDshBinFromManifests(dshManifestUrl, clientManifestUrl);
	if (existsSync(bin)) return {
		nodeArgs: [bin],
		patches: [],
		environment: {}
	};
	const packageDir = dirname(fileURLToPath(dshManifestUrl));
	const sourceBin = resolve(packageDir, "src/bin.ts");
	const sourcePatch = resolve(packageDir, "src/sdk-source.cordis.patch.yml");
	const sourceTsconfig = resolve(packageDir, "tsconfig.json");
	if (!existsSync(sourceBin) || !existsSync(sourcePatch) || !existsSync(sourceTsconfig)) throw new Error(`@deepseek-ai/dsh is missing its built executable ${bin} and complete source launch files ${sourceBin}, ${sourcePatch}, ${sourceTsconfig}`);
	return {
		nodeArgs: [
			"--import",
			sourceLoaderUrl ?? import.meta.resolve("tsx/esm"),
			sourceBin
		],
		patches: [sourcePatch],
		environment: { TSX_TSCONFIG_PATH: sourceTsconfig }
	};
}
/**
* Resolve the installed dsh package to a built or source Node launch.
* @returns the launch descriptor for the current checkout or installed package.
*/
function installedDshNodeLaunch() {
	return resolveDshNodeLaunchFromManifests(import.meta.resolve("@deepseek-ai/dsh/package.json"), new URL("../package.json", import.meta.url).href);
}
/**
* Resolve caller-relative filesystem inputs and construct canonical dsh argv.
* @param options - public SDK launch options.
* @param callerCwd - parent-process directory used for lexical resolution.
* @returns one generic subprocess spec for the JSON-RPC transport.
*/
function resolveDshLaunch(options = {}, callerCwd = process.cwd()) {
	const profile = options.profile ?? "sdk";
	const dshLaunch = options.dshBin === void 0 ? installedDshNodeLaunch() : {
		nodeArgs: [resolve(callerCwd, options.dshBin)],
		patches: [],
		environment: {}
	};
	const patches = [...dshLaunch.patches, ...(options.patches ?? []).map((path) => resolve(callerCwd, path))];
	const dshHome = options.dshHome === void 0 ? void 0 : resolve(callerCwd, options.dshHome);
	return {
		command: options.nodePath === void 0 ? process.execPath : resolve(callerCwd, options.nodePath),
		args: [
			...dshLaunch.nodeArgs,
			"--profile",
			profile,
			...patches.flatMap((path) => ["--patch", path])
		],
		...options.processCwd === void 0 ? {} : { cwd: resolve(callerCwd, options.processCwd) },
		environment: () => ({
			...options.env ?? process.env,
			...dshLaunch.environment,
			...dshHome === void 0 ? {} : { DSH_HOME: dshHome }
		}),
		description: `dsh profile ${JSON.stringify(profile)}`,
		initializeTimeoutMs: options.initializeTimeoutMs ?? 1e4,
		...options.requestTimeoutMs === void 0 ? {} : { requestTimeoutMs: options.requestTimeoutMs },
		...options.shutdownTimeoutMs === void 0 ? {} : { shutdownTimeoutMs: options.shutdownTimeoutMs },
		...options.disposeEofGraceMs === void 0 ? {} : { disposeEofGraceMs: options.disposeEofGraceMs },
		...options.disposeGraceMs === void 0 ? {} : { disposeGraceMs: options.disposeGraceMs }
	};
}
//#endregion
export { DEFAULT_INITIALIZE_TIMEOUT_MS, installedDshBin, resolveDshBinFromManifests, resolveDshLaunch, resolveDshNodeLaunchFromManifests };

//# sourceMappingURL=launch.mjs.map