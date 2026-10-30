// SPDX-License-Identifier: MIT
#include "../test_fixtures.h"
#include <xasyncprovider.h>
#include <atomic>
#include <thread>
#include <cstring>
#ifndef E_ILLEGAL_METHOD_CALL
#define E_ILLEGAL_METHOD_CALL _HRESULT_TYPEDEF_( 0x8000000E )
#endif

namespace
{
const char payloadIdentity = 0, wrongIdentity = 0;
struct Payload
{
    IXThreadingImpl *api;
    std::atomic<unsigned> reads{ 0 }, cleanups{ 0 };
};
HRESULT WINAPI PayloadProvider( XAsyncOp op, const XAsyncProviderData *data )
{
    auto payload = static_cast<Payload *>( data->context );
    switch ( op )
    {
    case XAsyncOp::Begin:
        return payload->api->XAsyncSchedule( data->async, 0 );
    case XAsyncOp::DoWork:
        payload->api->XAsyncComplete( data->async, S_OK, sizeof( DWORD ) );
        return E_PENDING;
    case XAsyncOp::GetResult:
    {
        ++payload->reads;
        Sleep( 20 );
        const DWORD value = 0x1234;
        memcpy( data->buffer, &value, sizeof( value ) );
        return S_OK;
    }
    case XAsyncOp::Cleanup:
        ++payload->cleanups;
        return S_OK;
    default:
        return S_OK;
    }
}
struct Fixture
{
    HMODULE module = LoadLibraryW( L"xgameruntime.dll" );
    IXThreadingImpl *api = nullptr;
    XTaskQueueHandle queue = nullptr;
    ~Fixture()
    {
        if ( queue ) api->XTaskQueueCloseHandle( queue );
        if ( api ) api->Release();
        if ( module ) FreeLibrary( module );
    }
    HRESULT Initialize()
    {
        using Query = HRESULT( WINAPI * )( REFCLSID, REFIID, void ** );
        auto query = module ? reinterpret_cast<Query>( GetProcAddress( module, "QueryApiImpl" ) ) : nullptr;
        if ( !query ) return E_FAIL;
        auto hr = query( CLSID_XThreadingImpl, __uuidof( IXThreadingImpl ), reinterpret_cast<void **>( &api ) );
        return FAILED( hr )
                   ? hr
                   : api->XTaskQueueCreate( XTaskQueueDispatchMode::Manual, XTaskQueueDispatchMode::Manual, &queue );
    }
};
}
TEST( NexusAsyncResults, BadArgumentsRetainThePayloadForACorrectedResultCall )
{
    Fixture fixture;
    ASSERT_EQ( fixture.Initialize(), S_OK );
    Payload payload{ fixture.api };
    XAsyncBlock async{};
    async.queue = fixture.queue;
    ASSERT_EQ( fixture.api->XAsyncBegin( &async, &payload, &payloadIdentity, "Payload", PayloadProvider ), S_OK );
    ASSERT_TRUE( fixture.api->XTaskQueueDispatch( fixture.queue, XTaskQueuePort::Work, 5000 ) );
    ASSERT_EQ( fixture.api->XAsyncGetStatus( &async, TRUE ), S_OK );
    DWORD value = 0;
    EXPECT_TRUE( FAILED( fixture.api->XAsyncGetResult( &async, &payloadIdentity, 1, &value, nullptr ) ) );
    EXPECT_TRUE(
        FAILED( fixture.api->XAsyncGetResult( &async, &payloadIdentity, sizeof( value ), nullptr, nullptr ) ) );
    EXPECT_EQ( fixture.api->XAsyncGetResult( &async, &wrongIdentity, sizeof( value ), &value, nullptr ), E_INVALIDARG );
    EXPECT_EQ( payload.reads, 0u );
    EXPECT_EQ( payload.cleanups, 0u );
    ASSERT_EQ( fixture.api->XAsyncGetResult( &async, &payloadIdentity, sizeof( value ), &value, nullptr ), S_OK );
    EXPECT_EQ( value, 0x1234u );
    EXPECT_EQ( payload.reads, 1u );
    EXPECT_EQ( payload.cleanups, 1u );
    EXPECT_EQ( fixture.api->XAsyncGetResult( &async, &payloadIdentity, sizeof( value ), &value, nullptr ),
               E_ILLEGAL_METHOD_CALL );
}
TEST( NexusAsyncResults, ConcurrentResultReadersCannotConsumeTheSamePayloadTwice )
{
    Fixture fixture;
    ASSERT_EQ( fixture.Initialize(), S_OK );
    Payload payload{ fixture.api };
    XAsyncBlock async{};
    async.queue = fixture.queue;
    ASSERT_EQ( fixture.api->XAsyncBegin( &async, &payload, &payloadIdentity, "Payload", PayloadProvider ), S_OK );
    ASSERT_TRUE( fixture.api->XTaskQueueDispatch( fixture.queue, XTaskQueuePort::Work, 5000 ) );
    HANDLE start = CreateEventW( nullptr, TRUE, FALSE, nullptr );
    ASSERT_NE( start, nullptr );
    HRESULT results[2] = { E_PENDING, E_PENDING };
    DWORD values[2]{};
    auto read = [&]( unsigned i )
    {
        WaitForSingleObject( start, 5000 );
        results[i] = fixture.api->XAsyncGetResult( &async, &payloadIdentity, sizeof( DWORD ), &values[i], nullptr );
    };
    std::thread first( read, 0 ), second( read, 1 );
    SetEvent( start );
    first.join();
    second.join();
    CloseHandle( start );
    EXPECT_TRUE( ( results[0] == S_OK && results[1] == E_ILLEGAL_METHOD_CALL ) ||
                 ( results[1] == S_OK && results[0] == E_ILLEGAL_METHOD_CALL ) );
    EXPECT_EQ( payload.reads, 1u );
    EXPECT_EQ( payload.cleanups, 1u );
    EXPECT_EQ( values[0] + values[1], 0x1234u );
}
namespace
{
struct Deferred
{
    IXThreadingImpl *api;
    XAsyncBlock *async = nullptr;
    std::atomic<unsigned> cleanups{ 0 };
};
HRESULT WINAPI DeferredProvider( XAsyncOp op, const XAsyncProviderData *data )
{
    auto deferred = static_cast<Deferred *>( data->context );
    switch ( op )
    {
    case XAsyncOp::Begin:
        deferred->async = data->async;
        return S_OK;
    case XAsyncOp::GetResult:
        memset( data->buffer, 0x5A, data->bufferSize );
        return S_OK;
    case XAsyncOp::Cleanup:
        ++deferred->cleanups;
        return S_OK;
    default:
        return S_OK;
    }
}
}
TEST( NexusAsyncResults, LateCompletionLeavesAReusedBlockToItsNewCall )
{
    // A title zeroes its block and starts a new call on it while the first
    // call is still pending. The first call must not complete the second.
    Fixture fixture;
    ASSERT_EQ( fixture.Initialize(), S_OK );
    Deferred first{ fixture.api }, second{ fixture.api };
    XAsyncBlock async{};
    async.queue = fixture.queue;
    ASSERT_EQ( fixture.api->XAsyncBegin( &async, &first, &payloadIdentity, "First", DeferredProvider ), S_OK );
    ASSERT_NE( first.async, nullptr );
    async = XAsyncBlock{};
    async.queue = fixture.queue;
    ASSERT_EQ( fixture.api->XAsyncBegin( &async, &second, &payloadIdentity, "Second", DeferredProvider ), S_OK );
    ASSERT_NE( second.async, nullptr );

    fixture.api->XAsyncComplete( first.async, S_OK, 0 );
    EXPECT_EQ( first.cleanups, 1u );
    EXPECT_EQ( fixture.api->XAsyncGetStatus( &async, FALSE ), E_PENDING );

    fixture.api->XAsyncComplete( second.async, S_OK, sizeof( DWORD ) );
    ASSERT_EQ( fixture.api->XAsyncGetStatus( &async, TRUE ), S_OK );
    DWORD value = 0;
    ASSERT_EQ( fixture.api->XAsyncGetResult( &async, &payloadIdentity, sizeof( value ), &value, nullptr ), S_OK );
    EXPECT_EQ( value, 0x5A5A5A5Au );
    EXPECT_EQ( second.cleanups, 1u );
}
