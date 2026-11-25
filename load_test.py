"""
Load test for the sticky whiteboard server.

Simulates many fake users connecting at once, each sending a batch of
note_moved events, and measures how long the server takes to respond
to each one (round-trip latency).

Usage:
    pip install "python-socketio[client]" requests websocket-client
    python load_test.py
"""

import time
import statistics
import socketio

SERVER_URL = 'http://localhost:5000'
NUM_USERS = 20          # how many fake users to simulate
EVENTS_PER_USER = 10    # how many edits each fake user sends

all_latencies = []  # collects every round-trip time, in milliseconds


def simulate_user(user_index):
    client = socketio.Client()
    client.connect(SERVER_URL)
    client.emit('join', {'room': 'loadtest'})  # the server needs to know the room
    time.sleep(0.05)

    note_id = f'loadtest-note-{user_index}'

    for i in range(EVENTS_PER_USER):
        payload = {
            'id': note_id,
            'x': i * 5,
            'y': i * 5,
            'updatedAt': time.time() * 1000
        }

        start = time.time()
        client.call('note_moved', payload)
        elapsed_ms = (time.time() - start) * 1000
        all_latencies.append(elapsed_ms)

    client.disconnect()
    print(f'  user {user_index + 1}/{NUM_USERS} done')  # progress, so it never looks frozen


def run_load_test():
    print(f'Simulating {NUM_USERS} users, {EVENTS_PER_USER} events each...')
    started = time.time()

    for i in range(NUM_USERS):
        simulate_user(i)

    total_time = time.time() - started
    print(f'\nFinished in {total_time:.1f} seconds.')
    print_results()


def print_results():
    if not all_latencies:
        print('No data collected.')
        return

    sorted_latencies = sorted(all_latencies)
    n = len(sorted_latencies)

    p50 = sorted_latencies[int(n * 0.50)]
    p95 = sorted_latencies[int(n * 0.95) - 1]
    p99 = sorted_latencies[min(int(n * 0.99), n - 1)]

    print('\n--- Load test results ---')
    print(f'Total requests: {n}')
    print(f'Min latency:    {min(sorted_latencies):.2f} ms')
    print(f'Median (p50):   {p50:.2f} ms')
    print(f'p95 latency:    {p95:.2f} ms')
    print(f'p99 latency:    {p99:.2f} ms')
    print(f'Max latency:    {max(sorted_latencies):.2f} ms')
    print(f'Mean latency:   {statistics.mean(sorted_latencies):.2f} ms')


if __name__ == '__main__':
    run_load_test()