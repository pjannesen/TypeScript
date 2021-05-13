/*@internal*/
namespace ts {
    export function getFileEmitOutput(program: Program, sourceFile: SourceFile, emitOnlyDtsFiles: boolean,
        cancellationToken?: CancellationToken, customTransformers?: CustomTransformers, forceDtsEmit?: boolean): EmitOutput {
        const outputFiles: OutputFile[] = [];
        const { emitSkipped, diagnostics, exportedModulesFromDeclarationEmit } = program.emit(sourceFile, writeFile, cancellationToken, emitOnlyDtsFiles, customTransformers, forceDtsEmit);
        return { outputFiles, emitSkipped, diagnostics, exportedModulesFromDeclarationEmit };

        function writeFile(fileName: string, text: string, writeByteOrderMark: boolean) {
            outputFiles.push({ name: fileName, writeByteOrderMark, text });
        }
    }

    export interface ReusableBuilderState {
        /**
         * Information of the file eg. its version, signature etc
         */
        fileInfos: ReadonlyESMap<Path, BuilderState.FileInfo>;
        /**
         * Contains the map of ReferencedSet=Referenced files of the file if module emit is enabled
         * Otherwise undefined
         * Thus non undefined value indicates, module emit
         */
        readonly referencedMap?: ReadonlyESMap<Path, BuilderState.ReferencedSet> | undefined;
        /**
         * Contains the map of exported modules ReferencedSet=exported module files from the file if module emit is enabled
         * Otherwise undefined
         */
        readonly exportedModulesMap?: ReadonlyESMap<Path, BuilderState.ReferencedSet> | undefined;
    }

    export interface BuilderState {
        /**
         * Information of the file eg. its version, signature etc
         */
        fileInfos: ESMap<Path, BuilderState.FileInfo>;
        /**
         * Contains the map of ReferencedSet=Referenced files of the file if module emit is enabled
         * Otherwise undefined
         * Thus non undefined value indicates, module emit
         */
        readonly referencedMap: ReadonlyESMap<Path, BuilderState.ReferencedSet> | undefined;
        /**
         * Contains the map of exported modules ReferencedSet=exported module files from the file if module emit is enabled
         * Otherwise undefined
         */
        readonly exportedModulesMap: ESMap<Path, BuilderState.ReferencedSet> | undefined;

        /**
         * true if file version is used as signature
         * This helps in delaying the calculation of the d.ts hash as version for the file till reasonable time
         */
        useFileVersionAsSignature: boolean;
        /**
         * Map of files that have already called update signature.
         * That means hence forth these files are assumed to have
         * no change in their signature for this version of the program
         */
        hasCalledUpdateShapeSignature: Set<Path>;
        /**
         * Cache of all files excluding default library file for the current program
         */
        allFilesExcludingDefaultLibraryFile?: readonly SourceFile[];
        /**
         * Cache of all the file names
         */
        allFileNames?: readonly string[];
    }

    export namespace BuilderState {
        /**
         * Information about the source file: Its version and optional signature from last emit
         */
        export interface FileInfo {
            readonly version: string;
            signature: string | undefined;
            affectsGlobalScope: boolean | undefined;
        }
        /**
         * Referenced files with values for the keys as referenced file's path to be true
         */
        export type ReferencedSet = ReadonlySet<Path>;
        /**
         * Compute the hash to store the shape of the file
         */
        export type ComputeHash = ((data: string) => string) | undefined;

        /**
         * Exported modules to from declaration emit being computed.
         * This can contain false in the affected file path to specify that there are no exported module(types from other modules) for this file
         */
        export type ComputingExportedModulesMap = ESMap<Path, ReferencedSet | false>;

        /**
         * Get the referencedFile from the imported module symbol
         */
        function getReferencedFileFromImportedModuleSymbol(symbol: Symbol) {
            if (symbol.declarations && symbol.declarations[0]) {
                const declarationSourceFile = getSourceFileOfNode(symbol.declarations[0]);
                return declarationSourceFile && declarationSourceFile.resolvedPath;
            }
        }

        /**
         * Returns true if oldState is reusable, that is the emitKind = module/non module has not changed
         */
        export function canReuseOldState(newReferencedMap: ReadonlyESMap<Path, ReferencedSet> | undefined, oldState: Readonly<ReusableBuilderState> | undefined) {
            return oldState && !oldState.referencedMap === !newReferencedMap;
        }

        /**
         * Creates the state of file references and signature for the new program from oldState if it is safe
         */
        export function create(newProgram: Program, oldState?: Readonly<ReusableBuilderState>, disableUseFileVersionAsSignature?: boolean): BuilderState {
            const fileInfos = new Map<Path, FileInfo>();
            const referencedMap = newProgram.getCompilerOptions().module !== ModuleKind.None ? new Map<Path, ReferencedSet>() : undefined;
            const exportedModulesMap = referencedMap ? new Map<Path, ReferencedSet>() : undefined;
            const hasCalledUpdateShapeSignature = new Set<Path>();
            const useOldState = canReuseOldState(referencedMap, oldState);

            // Ensure source files have parent pointers set
            newProgram.getTypeChecker();

            // Create the reference map, and set the file infos
            for (const sourceFile of newProgram.getSourceFiles()) {
                const version = Debug.checkDefined(sourceFile.version, "Program intended to be used with Builder should have source files with versions set");
                const oldInfo = useOldState ? oldState!.fileInfos.get(sourceFile.resolvedPath) : undefined;
                if (referencedMap) {
                    const newReferences = newProgram.getReferencedFiles(sourceFile);
                    if (newReferences) {
                        referencedMap.set(sourceFile.resolvedPath, newReferences);
                    }
                    // Copy old visible to outside files map
                    if (useOldState) {
                        const exportedModules = oldState!.exportedModulesMap!.get(sourceFile.resolvedPath);
                        if (exportedModules) {
                            exportedModulesMap!.set(sourceFile.resolvedPath, exportedModules);
                        }
                    }
                }
                fileInfos.set(sourceFile.resolvedPath, { version, signature: oldInfo && oldInfo.signature, affectsGlobalScope: isFileAffectingGlobalScope(sourceFile) || undefined });
            }

            return {
                fileInfos,
                referencedMap,
                exportedModulesMap,
                hasCalledUpdateShapeSignature,
                useFileVersionAsSignature: !disableUseFileVersionAsSignature && !useOldState
            };
        }

        /**
         * Releases needed properties
         */
        export function releaseCache(state: BuilderState) {
            state.allFilesExcludingDefaultLibraryFile = undefined;
            state.allFileNames = undefined;
        }

        /**
         * Creates a clone of the state
         */
        export function clone(state: Readonly<BuilderState>): BuilderState {
            // Dont need to backup allFiles info since its cache anyway
            return {
                fileInfos: new Map(state.fileInfos),
                referencedMap: state.referencedMap && new Map(state.referencedMap),
                exportedModulesMap: state.exportedModulesMap && new Map(state.exportedModulesMap),
                hasCalledUpdateShapeSignature: new Set(state.hasCalledUpdateShapeSignature),
                useFileVersionAsSignature: state.useFileVersionAsSignature,
            };
        }

        /**
         * Gets the files affected by the path from the program
         */
        export function getFilesAffectedBy(state: BuilderState, programOfThisState: Program, path: Path, cancellationToken: CancellationToken | undefined, computeHash: ComputeHash, cacheToUpdateSignature?: ESMap<Path, string>, exportedModulesMapCache?: ComputingExportedModulesMap): readonly SourceFile[] {
            // Since the operation could be cancelled, the signatures are always stored in the cache
            // They will be committed once it is safe to use them
            // eg when calling this api from tsserver, if there is no cancellation of the operation
            // In the other cases the affected files signatures are committed only after the iteration through the result is complete
            const signatureCache = cacheToUpdateSignature || new Map();
            const sourceFile = programOfThisState.getSourceFileByPath(path);
            if (!sourceFile) {
                return emptyArray;
            }

            if (!updateShapeSignature(state, programOfThisState, sourceFile, signatureCache, cancellationToken, computeHash, exportedModulesMapCache)) {
                return [sourceFile];
            }

            const result = (state.referencedMap ? getFilesAffectedByUpdatedShapeWhenModuleEmit : getFilesAffectedByUpdatedShapeWhenNonModuleEmit)(state, programOfThisState, sourceFile, signatureCache, cancellationToken, computeHash, exportedModulesMapCache);
            if (!cacheToUpdateSignature) {
                // Commit all the signatures in the signature cache
                updateSignaturesFromCache(state, signatureCache);
            }
            return result;
        }

        /**
         * Updates the signatures from the cache into state's fileinfo signatures
         * This should be called whenever it is safe to commit the state of the builder
         */
        export function updateSignaturesFromCache(state: BuilderState, signatureCache: ESMap<Path, string>) {
            signatureCache.forEach((signature, path) => updateSignatureOfFile(state, signature, path));
        }

        export function updateSignatureOfFile(state: BuilderState, signature: string | undefined, path: Path) {
            state.fileInfos.get(path)!.signature = signature;
            state.hasCalledUpdateShapeSignature.add(path);
        }

        /**
         * Returns if the shape of the signature has changed since last emit
         */
        export function updateShapeSignature(state: Readonly<BuilderState>, programOfThisState: Program, sourceFile: SourceFile, cacheToUpdateSignature: ESMap<Path, string>, cancellationToken: CancellationToken | undefined, computeHash: ComputeHash, exportedModulesMapCache?: ComputingExportedModulesMap) {
            Debug.assert(!!sourceFile);
            Debug.assert(!exportedModulesMapCache || !!state.exportedModulesMap, "Compute visible to outside map only if visibleToOutsideReferencedMap present in the state");

            // If we have cached the result for this file, that means hence forth we should assume file shape is uptodate
            if (state.hasCalledUpdateShapeSignature.has(sourceFile.resolvedPath) || cacheToUpdateSignature.has(sourceFile.resolvedPath)) {
                return false;
            }

            const info = state.fileInfos.get(sourceFile.resolvedPath);
            if (!info) return Debug.fail();

            const prevSignature = info.signature;
            let latestSignature: string | undefined;
            if (!sourceFile.isDeclarationFile && !state.useFileVersionAsSignature) {
                const emitOutput = getFileEmitOutput(
                    programOfThisState,
                    sourceFile,
                    /*emitOnlyDtsFiles*/ true,
                    cancellationToken,
                    /*customTransformers*/ undefined,
                    /*forceDtsEmit*/ true
                );
                const firstDts = firstOrUndefined(emitOutput.outputFiles);
                if (firstDts) {
                    Debug.assert(fileExtensionIs(firstDts.name, Extension.Dts), "File extension for signature expected to be dts", () => `Found: ${getAnyExtensionFromPath(firstDts.name)} for ${firstDts.name}:: All output files: ${JSON.stringify(emitOutput.outputFiles.map(f => f.name))}`);
                    latestSignature = (computeHash || generateDjb2Hash)(firstDts.text);
                    if (exportedModulesMapCache && latestSignature !== prevSignature) {
                        updateExportedModules(sourceFile, emitOutput.exportedModulesFromDeclarationEmit, exportedModulesMapCache);
                    }
                }
            }
            // Default is to use file version as signature
            if (latestSignature === undefined) {
                latestSignature = sourceFile.version;
                if (exportedModulesMapCache && latestSignature !== prevSignature) {
                    // All the references in this file are exported
                    const references = state.referencedMap ? state.referencedMap.get(sourceFile.resolvedPath) : undefined;
                    exportedModulesMapCache.set(sourceFile.resolvedPath, references || false);
                }
            }
            cacheToUpdateSignature.set(sourceFile.resolvedPath, latestSignature);
            return latestSignature !== prevSignature;
        }

        /**
         * Coverts the declaration emit result into exported modules map
         */
        function updateExportedModules(sourceFile: SourceFile, exportedModulesFromDeclarationEmit: ExportedModulesFromDeclarationEmit | undefined, exportedModulesMapCache: ComputingExportedModulesMap) {
            if (!exportedModulesFromDeclarationEmit) {
                exportedModulesMapCache.set(sourceFile.resolvedPath, false);
                return;
            }

            let exportedModules: Set<Path> | undefined;
            exportedModulesFromDeclarationEmit.forEach(symbol => addExportedModule(getReferencedFileFromImportedModuleSymbol(symbol)));
            exportedModulesMapCache.set(sourceFile.resolvedPath, exportedModules || false);

            function addExportedModule(exportedModulePath: Path | undefined) {
                if (exportedModulePath) {
                    if (!exportedModules) {
                        exportedModules = new Set();
                    }
                    exportedModules.add(exportedModulePath);
                }
            }
        }

        /**
         * Updates the exported modules from cache into state's exported modules map
         * This should be called whenever it is safe to commit the state of the builder
         */
        export function updateExportedFilesMapFromCache(state: BuilderState, exportedModulesMapCache: ComputingExportedModulesMap | undefined) {
            if (exportedModulesMapCache) {
                Debug.assert(!!state.exportedModulesMap);
                exportedModulesMapCache.forEach((exportedModules, path) => {
                    if (exportedModules) {
                        state.exportedModulesMap!.set(path, exportedModules);
                    }
                    else {
                        state.exportedModulesMap!.delete(path);
                    }
                });
            }
        }

        /**
         * Get all the dependencies of the sourceFile
         */
        export function getAllDependencies(state: BuilderState, programOfThisState: Program, sourceFile: SourceFile): readonly string[] {
            const compilerOptions = programOfThisState.getCompilerOptions();
            // With --out or --outFile all outputs go into single file, all files depend on each other
            if (outFile(compilerOptions)) {
                return getAllFileNames(state, programOfThisState);
            }

            // If this is non module emit, or its a global file, it depends on all the source files
            if (!state.referencedMap || isFileAffectingGlobalScope(sourceFile)) {
                return getAllFileNames(state, programOfThisState);
            }

            // Get the references, traversing deep from the referenceMap
            const seenMap = new Set<Path>();
            const queue = [sourceFile.resolvedPath];
            while (queue.length) {
                const path = queue.pop()!;
                if (!seenMap.has(path)) {
                    seenMap.add(path);
                    const references = state.referencedMap.get(path);
                    if (references) {
                        const iterator = references.keys();
                        for (let iterResult = iterator.next(); !iterResult.done; iterResult = iterator.next()) {
                            queue.push(iterResult.value);
                        }
                    }
                }
            }

            return arrayFrom(mapDefinedIterator(seenMap.keys(), path => programOfThisState.getSourceFileByPath(path)?.fileName ?? path));
        }

        /**
         * Gets the names of all files from the program
         */
        function getAllFileNames(state: BuilderState, programOfThisState: Program): readonly string[] {
            if (!state.allFileNames) {
                const sourceFiles = programOfThisState.getSourceFiles();
                state.allFileNames = sourceFiles === emptyArray ? emptyArray : sourceFiles.map(file => file.fileName);
            }
            return state.allFileNames;
        }

        /**
         * Gets the files referenced by the the file path
         */
        export function getReferencedByPaths(state: Readonly<BuilderState>, referencedFilePath: Path) {
            return arrayFrom(mapDefinedIterator(state.referencedMap!.entries(), ([filePath, referencesInFile]) =>
                referencesInFile.has(referencedFilePath) ? filePath : undefined
            ));
        }

        /**
         * For script files that contains only ambient external modules, although they are not actually external module files,
         * they can only be consumed via importing elements from them. Regular script files cannot consume them. Therefore,
         * there are no point to rebuild all script files if these special files have changed. However, if any statement
         * in the file is not ambient external module, we treat it as a regular script file.
         */
        function containsOnlyAmbientModules(sourceFile: SourceFile) {
            for (const statement of sourceFile.statements) {
                if (!isModuleWithStringLiteralName(statement)) {
                    return false;
                }
            }
            return true;
        }

        /**
         * Return true if file contains anything that augments to global scope we need to build them as if
         * they are global files as well as module
         */
        function containsGlobalScopeAugmentation(sourceFile: SourceFile) {
            return some(sourceFile.moduleAugmentations, augmentation => isGlobalScopeAugmentation(augmentation.parent as ModuleDeclaration));
        }

        /**
         * Return true if the file will invalidate all files because it affectes global scope
         */
        function isFileAffectingGlobalScope(sourceFile: SourceFile) {
            return containsGlobalScopeAugmentation(sourceFile) ||
                !isExternalOrCommonJsModule(sourceFile) && !containsOnlyAmbientModules(sourceFile);
        }

        /**
         * Gets all files of the program excluding the default library file
         */
        export function getAllFilesExcludingDefaultLibraryFile(state: BuilderState, programOfThisState: Program, firstSourceFile: SourceFile | undefined): readonly SourceFile[] {
            // Use cached result
            if (state.allFilesExcludingDefaultLibraryFile) {
                return state.allFilesExcludingDefaultLibraryFile;
            }

            let result: SourceFile[] | undefined;
            if (firstSourceFile) addSourceFile(firstSourceFile);
            for (const sourceFile of programOfThisState.getSourceFiles()) {
                if (sourceFile !== firstSourceFile) {
                    addSourceFile(sourceFile);
                }
            }
            state.allFilesExcludingDefaultLibraryFile = result || emptyArray;
            return state.allFilesExcludingDefaultLibraryFile;

            function addSourceFile(sourceFile: SourceFile) {
                if (!programOfThisState.isSourceFileDefaultLibrary(sourceFile)) {
                    (result || (result = [])).push(sourceFile);
                }
            }
        }

        /**
         * When program emits non modular code, gets the files affected by the sourceFile whose shape has changed
         */
        function getFilesAffectedByUpdatedShapeWhenNonModuleEmit(state: BuilderState, programOfThisState: Program, sourceFileWithUpdatedShape: SourceFile) {
            const compilerOptions = programOfThisState.getCompilerOptions();
            // If `--out` or `--outFile` is specified, any new emit will result in re-emitting the entire project,
            // so returning the file itself is good enough.
            if (compilerOptions && outFile(compilerOptions)) {
                return [sourceFileWithUpdatedShape];
            }
            return getAllFilesExcludingDefaultLibraryFile(state, programOfThisState, sourceFileWithUpdatedShape);
        }

        /**
         * When program emits modular code, gets the files affected by the sourceFile whose shape has changed
         */
        function getFilesAffectedByUpdatedShapeWhenModuleEmit(state: BuilderState, programOfThisState: Program, sourceFileWithUpdatedShape: SourceFile, cacheToUpdateSignature: ESMap<Path, string>, cancellationToken: CancellationToken | undefined, computeHash: ComputeHash, exportedModulesMapCache: ComputingExportedModulesMap | undefined) {
            if (isFileAffectingGlobalScope(sourceFileWithUpdatedShape)) {
                return getAllFilesExcludingDefaultLibraryFile(state, programOfThisState, sourceFileWithUpdatedShape);
            }

            const compilerOptions = programOfThisState.getCompilerOptions();
            if (compilerOptions && (compilerOptions.isolatedModules || outFile(compilerOptions))) {
                return [sourceFileWithUpdatedShape];
            }

            // Now we need to if each file in the referencedBy list has a shape change as well.
            // Because if so, its own referencedBy files need to be saved as well to make the
            // emitting result consistent with files on disk.
            const seenFileNamesMap = new Map<Path, SourceFile>();

            // Start with the paths this file was referenced by
            seenFileNamesMap.set(sourceFileWithUpdatedShape.resolvedPath, sourceFileWithUpdatedShape);
            const queue = getReferencedByPaths(state, sourceFileWithUpdatedShape.resolvedPath);
            while (queue.length > 0) {
                const currentPath = queue.pop()!;
                if (!seenFileNamesMap.has(currentPath)) {
                    const currentSourceFile = programOfThisState.getSourceFileByPath(currentPath)!;
                    seenFileNamesMap.set(currentPath, currentSourceFile);
                    if (currentSourceFile && updateShapeSignature(state, programOfThisState, currentSourceFile, cacheToUpdateSignature, cancellationToken, computeHash, exportedModulesMapCache)) {
                        queue.push(...getReferencedByPaths(state, currentSourceFile.resolvedPath));
                    }
                }
            }

            // Return array of values that needs emit
            return arrayFrom(mapDefinedIterator(seenFileNamesMap.values(), value => value));
        }
    }
}
