// SPDX-License-Identifier: MIT
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {officialUbuntuMirrors} from './ci/ubuntu-mirror.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=name=>fs.readFileSync(path.join(root,name),'utf8');
const contract=JSON.parse(read('tests/Nexus/contracts.lock.json'));
test('launch path diagnostics are opt-in and never include command arguments or change launch resolution',()=>{
    const source=read('src/System/XGame.cpp');
    const helper=source.split('static void TraceLaunchPath(')[1].split('void WINAPI XGameImpl::XLaunchNewGame')[0];
    assert.match(helper,/GetEnvironmentVariableA\( "NEXUS_LAUNCH_TRACE"/);
    assert.match(helper,/== 1 && enabled\[0\] == '1'/);
    assert.match(helper,/SetLastError\( saved \)/);
    assert.match(helper,/target=%\.512ls cwd=%\.512ls/);
    assert.doesNotMatch(helper,/\bargs\b|\bcommand\b|GetEnvironmentStrings|XODUS|XUSER/);
    assert.match(source,/TraceLaunchPath\( executable \);\s*if \( !CreateProcessW\( executable, command, NULL, NULL, FALSE, 0, NULL, NULL/);
});
test('bare launch names resolve only current-directory first then caller sibling, never PATH or qualified-path fallback',()=>{
    const source=read('src/System/XGame.cpp');
    const helper=source.split('static WCHAR *FindSiblingExecutable(')[1].split('void WINAPI XGameImpl::XLaunchNewGame')[0];
    assert.ok(helper.includes('wcspbrk( name, L"\\\\/:" )'));
    assert.match(helper,/GetModuleFileNameW\( nullptr, path, 32768 \)/);
    assert.match(helper,/attributes & FILE_ATTRIBUTE_DIRECTORY/);
    assert.doesNotMatch(helper,/SearchPath|GetEnvironmentVariable|SetCurrentDirectory/);
    assert.match(source,/error != ERROR_FILE_NOT_FOUND \|\| !\( sibling = FindSiblingExecutable\( executable \) \)/);
    assert.match(read('scripts/test-component.mjs'),/\['nexus_game-relaunch-search', 116\]/);
    const probe=read('tests/Nexus/game-relaunch-search-probe.c');
    for(const label of ['exact-target-cwd-and-arguments','no-unintended-target','invalid-image-written','directory-not-executable','current-copy','cwd-qualified-copy'])assert.ok(probe.includes(label));
});
test('title presence is optional, genuine-claim-bound and supported by its launcher before requesting tokens',()=>{
    const source=read('src/System/User/Presence.cpp'),user=read('src/System/XUser.cpp');
    assert.ok(source.indexOf('"presence-ready"')<source.indexOf('const auto hr = Prepare('));
    assert.match(source,/generation == worker->generation && xuser_is_current_user\( worker->user \)/);
    assert.match(source,/SecureZeroMemory/);assert.match(source,/FreeLibraryAndExitThread/);
    assert.match(user,/SUCCEEDED\( hr \) && \*newUser \) nexus::presence::Start/);
    assert.match(user,/presence && \( !title \|\| !user->titleToken/);
    assert.match(user,/actual != user->xuid/);
    assert.ok(source.includes('\\"state\\":\\"active\\"'));
    for(const value of ['UsesGenuineTitleDeviceAndMatchingUserAndSignsOnlyCurrentTitle','MissingTitleTokenNeverFallsBackToOrdinaryUserAuthorization','WrongMalformedOrMissingAuthenticatedIdentityNeverPublishes','MissingEndpointOrUnsupportedPolicyFailsClosedWithoutBreakingLogin','DenialCancelledAndInvalidInputsHaveNoPresenceSideEffects'])assert.ok(read('scripts/test-authentication.mjs').includes(value));
});
test('installation selectors retain whole-layout validation and live file checks without a stale cache',()=>{
    const chunks=read('src/System/Package/Chunks.h'),monitor=read('src/System/Package/Monitors.h');
    assert.match(monitor,/chunks_load\( monitor->identifier, TRUE, &snapshot, monitor->count, monitor->selectors \)/);
    assert.ok(chunks.indexOf('chunks_features( snapshot, root )')<chunks.indexOf('chunks_selected( &snapshot->chunks[i]'));
    assert.ok(chunks.indexOf('if ( !inspect_files ) continue;')>chunks.indexOf('!content_relative( relative, FALSE )'));
    assert.match(chunks,/&snapshot->registration, TRUE/);
    assert.match(chunks,/inspect_files \? XPackageChunkAvailability::Ready : XPackageChunkAvailability::Unavailable/);
    assert.match(chunks,/CreateFileW\( file, GENERIC_READ/);
    assert.match(chunks,/GetFileSizeEx\( readable/);
    assert.match(read('tests/CMakeLists.txt'),/package-progress-bytes package-selection/);
    assert.match(read('scripts/test-component.mjs'),/selection-file-opens/);
    const probe=read('tests/Nexus/package-selection-probe.c');
    for(const label of ['selected-locked-refresh','deleted-refresh','replace-refresh','resize-refresh','invalid-refresh','concurrent-refresh','invalid-unselected-metadata-rejected'])assert.ok(probe.includes('"'+label+'"'));
});
test('incomplete hints reorder live checks only after validating all declarations',()=>{
    const source=read('src/System/Package/Chunks.h'),monitor=read('src/System/Package/Monitors.h');
    assert.ok(source.indexOf('chunks_inspect_files( snapshot )')>source.lastIndexOf('chunks_files( path, chunk_nodes[i]'));
    assert.match(source,/wcsicmp\( hint, snapshot->file_groups\[i\]\.pattern \)/);
    assert.match(source,/chunks_inspect_group\( snapshot, index \)/);
    assert.match(monitor,/if \( delay > 5000 \) delay = 5000/);
    assert.match(monitor,/monitor->unchanged = 0/);
    assert.match(monitor,/monitor->unchanged < 3/);
    assert.match(read('scripts/test-component.mjs'),/repeated-incomplete-file-opens/);
    for(const label of ['unchanged-missing-refresh','restoration-rechecks-other-files','missing-hint-does-not-hide-invalid-layout','changed-layout-drops-old-blocker'])
        assert.ok(read('tests/Nexus/package-selection-probe.c').includes('"'+label+'"'));
});
test('all original raw migration assertions remain byte-identical',()=>{
    assert.equal(Object.keys(contract.probes).length,6);
    for(const [name,expected] of Object.entries(contract.probes))
        assert.equal(crypto.createHash('sha256').update(read('tests/Nexus/'+name)).digest('hex'),expected,name);
});
test('native work and timer callbacks retain their module without permanent pins',()=>{
    for(const file of ['ThreadPool.cpp','WaitTimer.cpp']) {
        const source=read('src/System/Threading/'+file);
        assert.match(source,/SetThreadpoolCallbackLibrary\(&environment, module\)/);
        assert.match(source,/GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT/);
        assert.doesNotMatch(source,/GET_MODULE_HANDLE_EX_FLAG_PIN/);
        assert.match(source,/DestroyThreadpoolEnvironment\(&environment\)/);
    }
    assert.match(read('scripts/test-component.mjs'),/package-close-unload-repeat/);
});
test('all upstream threading declarations remain present, including the 42 active cases',()=>{
    const names=[...read('tests/System/test_xthreading.cpp').matchAll(/TEST_F\(XThreadingTests,\s*(\w+)\)/g)].map(m=>m[1]);
    assert.equal(contract.upstreamDeclarations.length,45);
    assert.deepEqual(names,contract.upstreamDeclarations);
    assert.doesNotMatch(read('tests/System/test_xthreading.cpp'),/DISABLED_/);
});
test('both ABIs use explicit compiler and IDL inputs without permissive flags',()=>{
    assert.match(read('win32-target.cmake'),/i686-w64-mingw32-g\+\+/);
    assert.match(read('win64-target.cmake'),/x86_64-w64-mingw32-g\+\+/);
    assert.match(read('CMakeLists.txt'),/WIDL_ARCH -m32/);
    assert.match(read('CMakeLists.txt'),/WIDL_ARCH -m64/);
    assert.doesNotMatch(read('CMakeLists.txt')+read('src/CMakeLists.txt'),/-fpermissive|-Wno-error|--enable-stdcall-fixup/);
    assert.match(read('src/xgameruntime-x86.def'),/QueryApiImpl=QueryApiImpl@12/);
});
test('component CI cannot package, publish or imply complete runtime validation',()=>{
    const workflow=read('.github/workflows/test.yml');
    assert.match(workflow,/arch: \[win64, win32\]/);
    assert.match(workflow,/-DNEXUS_MIGRATION_PROBES=ON/);
    assert.match(workflow,/-DCMAKE_CXX_FLAGS=-O2/);
    assert.doesNotMatch(workflow,/-DNDEBUG|-fno-rtti|allow-multiple-definition|CMAKE_BUILD_TYPE=Release/);
    assert.match(workflow,/scripts\/test-component\.mjs/);
    assert.doesNotMatch(workflow,/gh release|build-proton|package-candidate|release-validation|secrets\./);
    assert.match(read('scripts/test-component.mjs'),/completeRuntime: false/);
    assert.match(read('scripts/test-component.mjs'),/realGameTest: false/);
    assert.match(read('scripts/test-component.mjs'),/stableApproved: false/);
    assert.match(read('tests/CMakeLists.txt'),/NEXUS_MIGRATION_PROBES[^\n]+ON/);
});
test('mirror configuration retains security origin, suites and signing keys',()=>{
    const source='URIs: http://azure.archive.ubuntu.com/ubuntu\nSuites: noble noble-updates\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\nhttp://security.ubuntu.com/ubuntu https://example.org/apt';
    const value=officialUbuntuMirrors(source);
    assert.ok(value.includes('https://archive.ubuntu.com/ubuntu'));
    assert.ok(value.includes('https://security.ubuntu.com/ubuntu'));
    assert.ok(value.includes('Suites: noble noble-updates'));
    assert.ok(value.includes('Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg'));
    assert.ok(value.includes('https://example.org/apt'));
});

test('configuration retains the original initialization ABI fixture',()=>{
    for(const [name,expected] of Object.entries(contract.configurationProbes))
        assert.equal(crypto.createHash('sha256').update(read('tests/Nexus/'+name)).digest('hex'),expected,name);
    for(const mode of ['inline','retry','default']) assert.ok(read('scripts/test-component.mjs').includes("'"+mode+"'"));
});
test('XML parser inputs are pinned and checked without fallback or external entity loading',()=>{
    const lock=JSON.parse(read('cmake/xml2.lock.json'));
    assert.equal(lock.commit,'7fc704ef49c50e9702c9983a5250d5738697bb04');
    assert.ok(Object.keys(lock.files).length>70);
    assert.match(read('cmake/Xml2.cmake'),/file\(SHA256/);
    assert.match(read('cmake/Xml2.cmake'),/FATAL_ERROR "Pinned XML source mismatch/);
    assert.match(read('src/Runtime/Xml.cpp'),/XML_PARSE_NONET/);
    assert.match(read('src/Runtime/Xml.cpp'),/XML_PARSER_LOADDTD, 0/);
    assert.match(read('src/Runtime/Xml.cpp'),/XML_PARSER_SUBST_ENTITIES, 0/);
    assert.doesNotMatch(read('src/Runtime/Xml.cpp'),/XML_PARSE_NOENT|XML_PARSE_DTDLOAD/);
});

test('authentication compiles pinned WinRT declarations and never exports transport injection',()=>{
    const lock=JSON.parse(read('cmake/winrt.lock.json'));
    assert.equal(lock.commit,'7fc704ef49c50e9702c9983a5250d5738697bb04');
    assert.equal(Object.keys(lock.files).length,13);
    assert.match(read('cmake/Winrt.cmake'),/file\(SHA256/);
    assert.match(read('cmake/Winrt.cmake'),/FATAL_ERROR "Pinned WinRT source mismatch/);
    assert.doesNotMatch(read('src/xgameruntime.def')+read('src/xgameruntime-x86.def'),/Transport|Synthetic|TestHook/);
    assert.match(read('scripts/test-authentication.mjs'),/Number\(match\[1\]\)>=27/);
    assert.match(read('scripts/test-authentication.mjs'),/realAccounts:false,realCloud:false,fullRuntime:false/);
    assert.match(read('tests/Nexus/test_user.cpp'),/There is deliberately no network fallback/);
});

test('authentication covers missing optional signature policies without accepting malformed fields',()=>{
    const tests=read('tests/Nexus/test_user.cpp');
    for(const name of ['MissingOptionalSignaturePolicyDoesNotFailEndpointMetadata',
        'SignedAndUnsignedEndpointOrderDoesNotChangeSuccess',
        'PresentInvalidSignaturePolicyIsNotTreatedAsMissing',
        'HandshakeAcceptsUnsignedTitleEndpointWithoutLosingIdentity'])
        assert.match(tests,new RegExp('TEST\\( NexusAuthentication, '+name+' \\)'));
    assert.match(tests,/return Reply\( currentEndpoints, output, length \)/);
});

test('delayed callbacks use actual monotonic Windows uptime in every SDK',()=>{
    assert.match(read('src/System/Threading/WaitTimer.cpp'),/GetTickCount64\(\)/);
    assert.doesNotMatch(read('src/System/Threading/WaitTimer.cpp'),/std::chrono::steady_clock|gettimeofday\(/);
    assert.match(read('scripts/test-component.mjs'),/test_nexus_timer\.exe/);
    assert.match(read('tests/Nexus/test_timer.cpp'),/EXPECT_GE\( state.fired, due \)/);
});

test('save migration preserves every original assertion and exercises actual C++ source',()=>{
    const lock=JSON.parse(read('tests/Nexus/save-contracts.lock.json'));
    for(const name of ['sync','transfer'])
    {
        const source=read('tests/Nexus/gamesave-'+name+'.cpp');
        const checks=[...source.matchAll(/\bCHECK\(\s*"([^"\n]+)"/g)].map(m=>m[1]);
        assert.deepEqual(checks.filter(x=>x!=='actual-config'),lock[name].originalChecks);
        assert.equal(lock[name].requiredNativeChecks,lock[name].originalNativeChecks+1);
        assert.ok(source.includes('#include "../../src/System/XGameSave.cpp"'));
        assert.doesNotMatch(source,/#include "xgamesave\.c"|IXUserImplVtbl/);
    }
    assert.match(read('src/System/GameSave/Transactions.h'),/incoming.transport = provider->transport/);
    assert.doesNotMatch(read('src/xgameruntime.def'),/SaveTransport|ClosedSaveTransport/);
});

test('file saves retain all ABI assertions and load their actual C++ helper DLL',()=>{
    const lock=JSON.parse(read('tests/Nexus/save-contracts.lock.json')).files;
    const source=read('tests/Nexus/gamesave-files.cpp');
    const checks=[...source.matchAll(/\bCHECK\(\s*"([^"\n]+)"/g)].map(m=>m[1]);
    assert.deepEqual(checks.filter(x=>!lock.addedChecks.includes(x)),lock.originalChecks);
    assert.equal(lock.originalNativeChecks,21); assert.equal(lock.requiredNativeChecks,25);
    assert.match(source,/System\/User\/XUser\.h/);
    assert.doesNotMatch(source,/IUserVtbl|struct test_user|userprovider\.h/);
    assert.match(read('src/System/GameSave/Files.h'),/GetModuleFileNameW\( module, modulePath/);
    assert.match(read('scripts/test-component.mjs'),/save-child-drain/);
    for(const file of ['scripts/test-component.mjs','scripts/test-authentication.mjs','scripts/test-saves.mjs'])
        assert.match(read(file),/XUSER_\|NEXUS_\|XGAMERUNTIME_/);
});

test('save result APIs never inspect opaque async storage or share operation identities',()=>{
    const source=read('src/System/XGameSave.cpp');
    assert.doesNotMatch(source,/async->internal/);
    assert.match(source,/saveOperationIdentities\[context->kind\]/);
    assert.match(source,/saveOperationIdentities\[kind\]/);
    assert.match(read('scripts/test-saves.mjs'),/Number\(match\[1\]\)>=6/);
});

test('atomic file saves construct a full wide sibling path without CRT formatting',()=>{
    const source=read('src/System/GameSave/Files.h');
    const write=source.slice(source.indexOf('static HRESULT files_write('),source.indexOf('/* Enumerate each complete parent'));
    assert.doesNotMatch(write,/swprintf/);
    assert.match(write,/length \+ 5 >= ARRAY_SIZE\( temp \)/);
    assert.match(write,/memcpy\( temp, wide, length \* sizeof\( WCHAR \) \)/);
    assert.match(write,/memcpy\( temp \+ length, L"\.tmp", sizeof\( L"\.tmp" \) \)/);
    assert.match(write,/CREATE_NEW/);
    assert.match(write,/FlushFileBuffers/);
    assert.match(write,/MOVEFILE_REPLACE_EXISTING \| MOVEFILE_WRITE_THROUGH/);
    const fixture=read('tests/Nexus/gamesave-file-paths.cpp');
    assert.match(fixture,/#include "gamesave-transfer.cpp"/);
    for(const label of ['write-unicode-away-from-cwd','replace-away-from-cwd','empty-write','readonly-replacement-fails','foreign-temporary-not-overwritten','parallel-independent-cwd','long-path-rejected','closed-synthetic-transport'])
        assert.ok(fixture.includes('"'+label+'"'),label);
    assert.match(read('scripts/test-component.mjs'),/\['nexus_gamesave-file-paths', 55\]/);
    assert.match(read('tests/CMakeLists.txt'),/add_executable\(nexus_gamesave-file-paths Nexus\/gamesave-file-paths.cpp\)/);
});

test('versioned private COM declarations must not collapse independent C++ virtual slots',()=>{
    const interfaces={};
    for(const file of fs.readdirSync(path.join(root,'include')).filter(x=>x.endsWith('.idl')))
    {
        const source=read('include/'+file).replace(/\/\*[\s\S]*?\*\//g,'');
        for(const m of source.matchAll(/interface\s+(\w+)\s*:\s*(\w+)\s*\{([^}]*)\}/g))
            interfaces[m[1]]={file,parent:m[2],names:[...m[3].matchAll(/\b(?:HRESULT|BOOLEAN|UINT32|INT32|UINT64|ULONG|void)\s+(\w+)\s*\(/g)].map(x=>x[1])};
    }
    const inherited=name=>interfaces[name]?[...inherited(interfaces[name].parent),...interfaces[name].names]:[];
    for(const [name,value]of Object.entries(interfaces))
    {
        const ancestors=new Set(inherited(value.parent));
        for(const method of value.names)assert.ok(!ancestors.has(method),name+' redeclares '+method+' and collapses its appended slot');
    }
});

test('original raw package probes remain independent and child DLL staging is prefix-local',()=>{
    const lock=JSON.parse(read('tests/Nexus/package-contracts.lock.json'));
    assert.equal(Object.keys(lock.originalProbes).length,5);
    for(const [name,expected]of Object.entries(lock.originalProbes))
        assert.equal(crypto.createHash('sha256').update(read('tests/Nexus/'+name)).digest('hex'),expected,name);
    const x86=read('tests/Nexus/package-legacy-32-probe.c');
    assert.equal(x86,read('tests/Nexus/package-legacy-probe.c')
        .replace('    const char *identifier;\n    uint16_t major','    const char *identifier;\n    UINT32 versionAlignmentPadding; /* XVersion includes an 8-aligned uint64 value. */\n    uint16_t major')
        .replace('sizeof(Details) == 80, "x64 package details ABI"','sizeof(Details) == 56, "x86 package details ABI"')
        .replace('offsetof(Details, major) == 8 && offsetof(Details, title) == 72, "x64 package field offsets"','offsetof(Details, major) == 8 && offsetof(Details, title) == 52, "x86 package field offsets"'));

    assert.match(read('scripts/test-component.mjs'),/COPYFILE_EXCL/);
    assert.match(read('scripts/test-component.mjs'),/fs.renameSync\(temporary,staged\)/);
    assert.match(read('scripts/test-component.mjs'),/hash\(staged\)!==before/);
});

test('C++ Store and content helpers retain every original account-free assertion',()=>{
    const lock=JSON.parse(read('tests/Nexus/store-contracts.lock.json'));
    for(const name of ['store-entitlements','package-content'])
    {
        const source=read('tests/Nexus/'+name+'.cpp');
        const checks=[...source.matchAll(/\bCHECK\(\s*"([^"\n]+)"/g)].map(m=>m[1]);
        assert.deepEqual(checks.filter(x=>!lock[name].addedChecks.includes(x)),lock[name].originalChecks);
        assert.deepEqual(checks.filter(x=>lock[name].addedChecks.includes(x)),lock[name].addedChecks);
        assert.doesNotMatch(source,/#include "xstore_.*\.h"|#include "xpackage_content\.h"/);
    }
    assert.match(read('tests/Nexus/store-entitlements.cpp'),/The license bridge below always fails/);
    assert.doesNotMatch(read('src/xgameruntime.def'),/Fixture|receipt_verify|GetStoreProductId/);
});

test('current game licenses require proof-bound genuine SKU and support safe cancellation',()=>{
    const source=read('src/System/Store/GameLicense.h').replace(/\s+/g,'');
    assert.match(source,/snapshot->proof_until<=now/);
    assert.match(source,/entitled_sku_id\(sku.skuId\)/);
    assert.doesNotMatch(source,/4102444800|0010|isActive\s*=\s*TRUE[\s\S]*return E_NOTIMPL/);
    assert.match(read('src/System/Store/Entitled.h').replace(/\s+/g,''),/InterlockedCompareExchange\(&context->terminal,1,0\)/);
    assert.match(read('tests/Nexus/store-entitlements.cpp').replace(/\s+/g,''),/VirtualFree\(block,0,MEM_RELEASE\)/);
    assert.match(read('scripts/test-store.mjs'),/\['store-entitlements',982\]/);
    assert.match(read('scripts/test-store.mjs'),/realAccounts:false,realCloud:false,fullRuntime:false/);
});

test('public Store URL regressions capture exact paths without sending requests or changing trust',()=>{
    const source=read('src/System/Store/Receipts.h');
    assert.doesNotMatch(source,/L"[^"\n]*%S/);
    assert.match(source,/fullCertificate\/%hs/);
    assert.match(source,/bigIds=%hs&market=%hs&languages=%hs/);
    const fixture=read('tests/Nexus/store-entitlements.cpp');
    assert.match(fixture,/#define WinHttpSendRequest FixturePublicSendRequest/);
    const send=fixture.split('static BOOL WINAPI FixturePublicSendRequest')[1].split('#define QueryApiImpl')[0];
    assert.match(send,/SetLastError\( ERROR_CANCELLED \)/);
    assert.match(send,/return FALSE/);
    assert.doesNotMatch(send,/WinHttpSendRequest\(/);
    assert.match(fixture,/public-certificate-path-exact/);
    assert.match(fixture,/public-catalog-language-path-exact/);
    assert.match(source,/BCryptVerifySignature/);
    assert.match(source,/strcmp\( challenge, nonce \)/);
});

test('relaunch and async-provider contracts remain byte-identical and account-free',()=>{
    const lock=JSON.parse(read('tests/Nexus/provider-contracts.lock.json'));
    assert.equal(Object.keys(lock.originalProbes).length,2);
    for(const [name,expected]of Object.entries(lock.originalProbes))
        assert.equal(crypto.createHash('sha256').update(read('tests/Nexus/'+name)).digest('hex'),expected,name);
    assert.match(read('tests/Nexus/game-relaunch-probe.c'),/Never calls XUserAdd/);
});

test('optional API families use actual C++ providers without fabricated availability or event tokens',()=>{
    assert.doesNotMatch(read('src/System/XGameRuntimeFeature.cpp'),/Always assume/);
    assert.match(read('src/System/XGameRuntimeFeature.cpp'),/default:[\s\S]*return FALSE/);
    for(const name of ['XGameActivation','XGameInvite','XGameProtocol'])
    {
        const source=read('src/System/'+name+'.cpp');
        assert.doesNotMatch(source,/InterlockedIncrement|return S_OK/);
        assert.match(source,/token->token\s*=\s*0/);
    }
    assert.match(read('tests/Nexus/test_optional_providers.cpp'),/DisplayAndLauncherShareCanonicalIUnknown/);
});

test('invitations bind actual runtime user, service session and queued activation without protocol execution',()=>{
    const network=read('src/System/GameInvite/Network.cpp'),events=read('src/System/GameInvite/Events.cpp'),ui=read('src/System/GameInvite/Ui.cpp');
    assert.match(network,/XUserGetTokenAndSignatureAsync/);
    assert.match(network,/xuser_is_current_user/);
    assert.match(network,/https:\/\/sessiondirectory\.xboxlive\.com\/handles/);
    assert.match(network,/activities\/query/);
    assert.match(network,/WinHttpWebSocketCompleteUpgrade/);
    assert.match(network,/WINHTTP_FLAG_ASYNC/);
    assert.match(network,/state->outgoing = frame/);
    assert.doesNotMatch(network,/SECURITY_FLAG_IGNORE|WINHTTP_OPTION_SECURITY_FLAGS|WINHTTP_OPTION_RECEIVE_TIMEOUT/);
    assert.match(events,/XTaskQueuePort::Completion/);
    assert.match(events,/currentRegistration != registration.get\(\)/);
    assert.match(ui,/GetAsyncStatusForIdentity\( async, &inviteIdentity/);
    assert.match(ui,/GetAsyncStatusForIdentity\( async, &activityIdentity/);
    assert.match(ui,/CloseHandle\( thread \);\s*return E_PENDING;/);
    assert.doesNotMatch(network+events+ui,/ShellExecute|TerminateThread|GET_MODULE_HANDLE_EX_FLAG_PIN/);
    assert.match(read('src/System/XGameRuntimeFeature.cpp'),/case XGameRuntimeFeature::XGameInvite:\s*return nexus::invites::BridgeAvailable\(\)/);
    assert.match(read('scripts/test-component.mjs'),/\['nexus_game-invitations', 56, \['--component'\]\]/);
    assert.match(read('scripts/test-user-contracts.mjs'),/\['game-invitations',86\]/);
    assert.match(read('tests/Nexus/game-invitations.cpp'),/else \{ Callbacks\(\); Requests\(\); Incoming\(\); Dialogs\(\); UnregisterWait\(\); \}/);
});

test('the C++ runtime preserves the explicit cloud shutdown drain outside DllMain',()=>{
    assert.match(read('src/main.cpp'),/return nexus::DrainCloudShutdown/);
    assert.match(read('src/xgameruntime.def'),/NexusRegisterCloudShutdown/);
    assert.match(read('src/xgameruntime-x86.def'),/NexusRegisterCloudShutdown=NexusRegisterCloudShutdown@8/);
    assert.match(read('tests/Nexus/test_shutdown.cpp'),/ReentrantConcurrentRegistration/);
    const loader=read('src/main.cpp').split('HRESULT WINAPI InitializeApiImplEx2')[0];
    assert.doesNotMatch(loader,/DrainCloudShutdown\(|WaitFor|RegisterCloudShutdown\(/);
});

test('all original user fixture assertions remain in actual C++ source tests',()=>{
    const lock=JSON.parse(read('tests/Nexus/user-contracts.lock.json'));
    for(const [key,file]of [['device','user-device-association'],['audio','user-audio'],['metadata','windows-account-metadata'],['privilege','user-privilege']])
    {
        const entry=lock[key],source=read('tests/Nexus/'+file+'.cpp');
        const checks=[...source.matchAll(/\bCHECK\(\s*"([^"\n]+)"/g)].map(x=>x[1]).filter(x=>!(entry.addedChecks||[]).includes(x));
        assert.deepEqual(checks.sort(),[...entry.originalChecks].sort());
        assert.doesNotMatch(source,/IUserVtbl|IMMDeviceVtbl|IMMDeviceEnumeratorVtbl/);
    }
    assert.match(read('tests/Nexus/user-audio.cpp'),/public IMMDeviceEnumerator/);
    assert.match(read('tests/Nexus/windows-account-metadata.cpp'),/System\/User\/Tickets.h/);
});
test('public token encodings have distinct identities and validate inputs before allocation',()=>{
    const source=read('src/System/XUser.cpp');
    assert.match(source,/XAsyncBegin\( async, context, &tokenSignatureIdentity/);
    assert.match(source,/XAsyncBegin\( async, context, &tokenSignatureUtf16Identity/);
    assert.match(source,/AddTokenContextSize/);
    assert.doesNotMatch(source,/contextSize \+ headersSize/);
    assert.match(read('tests/Nexus/test_user.cpp'),/TokenAndPictureWorkersPreserveManualDispatchAndCancelledOwnership/);
});

test('privilege result APIs never decode opaque async bytes or export an identity hook',()=>{
    assert.doesNotMatch(read('src/System/User/Privileges.h'),/async->internal/);
    assert.match(read('src/System/User/Privileges.h'),/GetAsyncStatusForIdentity/);
    assert.doesNotMatch(read('src/xgameruntime.def')+read('src/xgameruntime-x86.def'),/GetAsyncStatusForIdentity/);
    assert.match(read('src/System/Threading/XAsync.cpp'),/completedIdentity==state->identity/);
    assert.match(read('tests/Nexus/test_async_identity.cpp'),/ConcurrentCompletionNeverInterpretsTerminalIdentityAsLiveState/);
});

test('numeric auth privacy assertions remain and bounded retry uses the actual C++ worker',()=>{
    const entry=JSON.parse(read('tests/Nexus/user-contracts.lock.json')).authLogger;
    const source=read('tests/Nexus/auth-metadata.cpp');
    assert.deepEqual([...source.matchAll(/\bCHECK\(\s*"([^"\n]+)"/g)].map(x=>x[1]),entry.originalPrivacyChecks);
    assert.match(source,/System\/XUser.cpp/);
    assert.match(read('src/System/XUser.cpp'),/attempt < 5/);
    assert.match(read('src/System/User/Transport.h'),/WaitForSignInRetry/);
    assert.match(read('tests/Nexus/test_user.cpp'),/SignInRetryKeepsFiveAttemptBoundAndNumericDiagnostics/);
});

test('desktop streaming lifecycle never advertises remote streaming support or writes client IDs',()=>{
    const source=read('src/System/XGameStreaming.cpp');
    assert.match(source,/std::atomic<bool> desktopInitialized/);
    assert.match(source,/desktopInitialized\.store\( true, std::memory_order_release \)/);
    assert.match(source,/desktopInitialized\.store\( false, std::memory_order_release \)/);
    assert.match(source,/if \( clientsUsed \) \*clientsUsed = 0/);
    assert.match(source,/return E_GAMESTREAMING_NOT_INITIALIZED/);
    const features=read('src/System/XGameRuntimeFeature.cpp');
    assert.doesNotMatch(features,/case XGameRuntimeFeature::XGameStreaming:/);
    assert.match(read('tests/Nexus/test_optional_providers.cpp'),/ConcurrentInitializationAndTeardownNeverInventClients/);
    assert.match(read('scripts/test-component.mjs'),/Number\(match\[1\]\) < 77/);
});

test('WinRT-dependent privilege validation has a separate matching-engine gate',()=>{
    assert.match(read('scripts/test-user-contracts.mjs'),/PINNED_WINE_EXECUTABLE/);
    assert.match(read('scripts/test-user-contracts.mjs'),/user-privilege',1162/);
    assert.match(read('scripts/test-user-contracts.mjs'),/auth-metadata',200/);
    assert.doesNotMatch(read('scripts/test-component.mjs'),/\['nexus_user-privilege',/);
    assert.match(read('src/System/Threading/XAsync.cpp'),/std::atomic<DWORD> signature/);
});
