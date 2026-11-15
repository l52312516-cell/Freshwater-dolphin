"""Synthetic full-chain test against AstrBot's aiocqhttp transport; no QQ login."""
import asyncio
import contextlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile

from aiocqhttp import CQHttp
from hypercorn.asyncio import serve
from hypercorn.config import Config

ROOT = Path(__file__).resolve().parents[1]


async def main():
    directory = Path(tempfile.mkdtemp(prefix='aiocqhttp-', dir=str(ROOT / 'work/temp')))
    bot = CQHttp(__name__, access_token='synthetic-token', api_timeout_sec=3)
    ready = asyncio.Event()
    received = []
    incoming = asyncio.Event()

    @bot.on_meta_event('lifecycle')
    async def lifecycle(event):
        ready.set()

    @bot.on_message
    async def message(event):
        assert isinstance(event.message, list)
        received.append(dict(event))
        if len(received) == 3:
            incoming.set()

    with socket.socket() as reservation:
        reservation.bind(('127.0.0.1', 0))
        port = reservation.getsockname()[1]
    settings = Config()
    settings.bind = ['127.0.0.1:%d' % port]
    settings.accesslog = None
    shutdown = asyncio.Event()
    server = asyncio.create_task(serve(bot.asgi, settings, shutdown_trigger=shutdown.wait))
    await asyncio.sleep(0.2)
    env = dict(os.environ, TEMP=str(ROOT / 'work/temp'), TMP=str(ROOT / 'work/temp'), TMPDIR=str(ROOT / 'work/temp'))
    log = (directory / 'node.log').open('w', encoding='utf-8')
    process = subprocess.Popen(['node', str(ROOT / 'tests/fixtures/runtime.cjs'), str(directory), 'ws://127.0.0.1:%d/ws' % port],
                               cwd=str(ROOT), env=env, stdin=subprocess.PIPE, stdout=log, stderr=log)
    try:
        await asyncio.wait_for(ready.wait(), 10)
        login = await bot.get_login_info(self_id=12345)
        assert login['user_id'] == 12345
        state = await bot.get_status(self_id=12345)
        assert state['online'] is True
        await asyncio.wait_for(incoming.wait(), 10)
        assert received[0]['message'][0]['data']['text'] == 'Synthetic 私聊\n'
        assert [item['type'] for item in received[2]['message']] == ['reply', 'at', 'text']
        quoted_id = received[1]['message_id']
        quoted = await bot.get_msg(self_id=12345, message_id=quoted_id)
        assert quoted['message'][0]['data']['text'] == 'Synthetic 群聊'
        member = await bot.get_group_member_info(self_id=12345, group_id=33333, user_id=22222)
        assert member['card'] == 'Synthetic card'
        reply = await bot.send_group_msg(self_id=12345, group_id=33333, message=[
            {'type': 'reply', 'data': {'id': str(quoted_id)}},
            {'type': 'at', 'data': {'qq': '22222'}},
            {'type': 'text', 'data': {'text': ' exact reply\n'}}])
        assert isinstance(reply['message_id'], int)
        private = await bot.send_private_msg(self_id=12345, user_id=22222, message='Synthetic private reply', auto_escape=True)
        assert isinstance(private['message_id'], int)
        recorded = json.loads((directory / 'sent.json').read_text(encoding='utf-8'))
        assert recorded[-2]['elements'][0]['elementType'] == 7
        assert recorded[-2]['elements'][1]['textElement']['atType'] == 2
        assert recorded[-2]['elements'][2]['textElement']['content'] == ' exact reply\n'
        result = {'client': 'aiocqhttp 1.4.4', 'synthetic': True, 'real_qq': False,
                  'received': len(received), 'private_send': True, 'group_send': True, 'mention': True,
                  'quote': True, 'get_msg': True, 'status': 'passed'}
        (ROOT / 'outputs/aiocqhttp-verification.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(json.dumps(result, ensure_ascii=False))
    finally:
        if process.poll() is None:
            process.stdin.write(b'stop\n')
            process.stdin.flush()
            for _ in range(100):
                if process.poll() is not None:
                    break
                await asyncio.sleep(0.02)
            if process.poll() is None:
                process.terminate()
            process.wait(timeout=5)
        log.close()
        shutdown.set()
        with contextlib.suppress(asyncio.CancelledError):
            await server
        shutil.rmtree(directory)


if __name__ == '__main__':
    asyncio.run(main())
