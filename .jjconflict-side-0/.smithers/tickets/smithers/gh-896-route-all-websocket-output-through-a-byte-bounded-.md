# Route all WebSocket output through a byte-bounded backpressure writer

GitHub: https://github.com/smithersai/smithers/issues/896

Introduce one writer for responses and events that accounts for serialized bytes, applies bounded buffering and slow-consumer handling, and route generic events, replay frames, heartbeats, and stream errors through it; add real slow-socket coverage.
