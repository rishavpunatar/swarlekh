"""Durable expert examples. No model weights are altered by saving feedback."""
import hashlib
import json
import math
import os
import tempfile


def save_feedback(payload, directory):
    if not isinstance(payload, dict) or payload.get('purpose') != 'expert-correction' or payload.get('reviewed') is not True:
        raise ValueError('Submit an expert-reviewed finished score.')
    file = payload.get('file')
    sha = file.get('sha256') if isinstance(file, dict) else None
    if not isinstance(sha, str) or len(sha) != 64 or any(c not in '0123456789abcdef' for c in sha):
        raise ValueError('A valid recording hash is required.')
    duration = file.get('duration')
    if not isinstance(duration, (int, float)) or not math.isfinite(duration) or not 0 < duration <= 10800:
        raise ValueError('Invalid recording duration.')
    baseline = payload.get('baseline')
    if not isinstance(baseline, dict) or not isinstance(baseline.get('notes'), list):
        raise ValueError('The original machine draft is required.')
    for score in (payload, baseline):
        sa = score.get('saHz')
        if not isinstance(sa, (int, float)) or not math.isfinite(sa) or not 20 <= sa <= 2000:
            raise ValueError('Invalid Sa.')
        notes = score.get('notes')
        if not isinstance(notes, list) or len(notes) > 100000 or (score is payload and not notes):
            raise ValueError('Invalid notes.')
        for note in notes:
            if not isinstance(note, dict) or any(not isinstance(note.get(k), (int, float)) or not math.isfinite(note[k]) for k in ('t0', 't1', 'k')):
                raise ValueError('Invalid note timing or pitch.')
            if not 0 <= note['t0'] < note['t1'] <= duration + .01 or not -96 <= note['k'] <= 96:
                raise ValueError('Notes must fit within the recording.')
    # The same finished score is idempotent; a changed score becomes a revision.
    canonical = {key: value for key, value in payload.items() if key != 'exportedAt'}
    encoded = json.dumps(canonical, sort_keys=True, allow_nan=False, separators=(',', ':')).encode()
    if len(encoded) > 32 * 1024 * 1024:
        raise ValueError('The finished score must be under 32 MB.')
    identifier = hashlib.sha256(encoded).hexdigest()
    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, identifier + '.json')
    fd, temporary = tempfile.mkstemp(dir=directory, prefix='.pending-')
    try:
        with os.fdopen(fd, 'wb') as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return identifier
