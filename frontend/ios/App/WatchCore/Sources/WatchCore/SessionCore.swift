import Foundation

/*
 * The session as the watch keeps it, and every change to it, as pure functions: the watch app's
 * SessionStore only calls these, saves the state after each, and sends the events they return.
 * Tested with `swift test` (Tests/WatchCoreTests), no watch needed.
 *
 * The sync, case by case (the phone's side: frontend lib/watch-sync.js):
 *
 *   watch app never opened before the workout started on the phone
 *       the phone keeps its snapshot as the application context, which the watch reads when it
 *       launches (applySnapshot): it picks the running workout up where the phone has it.
 *   watch app killed and relaunched mid-workout
 *       the whole state is saved after every change and restored at launch; then the latest
 *       snapshot is applied over it, with the watch's own unconfirmed ticks kept (below).
 *   phone asleep, locked in a pocket, app killed, Bluetooth off, out of range
 *       the watch runs the session alone; each tick, start and finish is an event sent with
 *       transferUserInfo, which the system queues and delivers, in order, when it can; the phone
 *       applies each one once, by its id.
 *   a snapshot older than the watch's own ticks (sent before the phone applied them)
 *       a tick stays pending until a snapshot shows that set done at the tick's time or later;
 *       until then the snapshot's copy of that set is replaced by the watch's.
 *   the same set changed on both sides
 *       the later tick (`at`) wins, on both sides: here in applySnapshot, on the phone in the
 *       workout screen's watch handler.
 *   finished on the watch while the phone was away
 *       the workout leaves the watch at once; a snapshot that still shows it running (the phone
 *       has not heard yet) does not bring it back.
 *   finished on the phone while the watch was away
 *       a snapshot without it ends it here; ticks the watch made meanwhile are still sent, and
 *       the phone writes them into the saved workout.
 *   started on the watch while the phone was away
 *       kept until the phone reports it back running; a snapshot without an active workout does
 *       not end it. If the phone started another workout meanwhile, the phone's workout wins and
 *       the unconfirmed watch workout is abandoned before any of its ticks can land on it.
 */

struct PendingTick: Codable, Equatable {
    var w: Double?
    var r: Double?
    var at: Double
    /// A hold's seconds.
    var sec: Double?
}

struct SessionState: Codable, Equatable {
    var workout: ActiveWorkout?
    var ready: Ready?
    var settings = WatchSettings()
    var unit = "kg"
    var restSec: Double = 90
    /// A session started here that the phone has not reported back running yet.
    var startedHere: String?
    /// Sessions finished here that the phone may still report running for a while.
    var finishedHere: [String] = []
    /// When each of those finished (ms since 1970, as in the finish event), so a phone snapshot
    /// sent long after the finish can reuse the same workout id without being blocked forever.
    /// Optional, like every field added later, so a state saved by an older build still loads.
    var finishedAt: [String: Double]?
    /// Ticks made here, by `SessionCore.key` ("exerciseId#entryIndex#setIndex"), until a snapshot
    /// shows them.
    var pending: [String: PendingTick] = [:]
    /// The exercise on screen.
    var entryIndex = 0
    /// Sets passed over here (`SessionCore.key`), not done: the next one comes up instead.
    /// Optional, like every field added later, so a state saved by an older build still loads.
    var skipped: [String]?
    /// The newest stamped phone snapshot applied here. Persisted so a relaunch cannot replay an
    /// application context from before the workout that is currently running.
    var lastSnapshotAt: Double?
}

/// The state after a phone snapshot, plus the watch workout it had to abandon because the phone
/// started a different one first. SessionStore uses the id to end the old HealthKit session.
struct SnapshotApplyResult: Equatable {
    var state: SessionState
    var abandonedWorkoutID: String?
    /// The phone explicitly has no active workout, so this local workout ended there. SessionStore
    /// ends its HealthKit session and returns to idle without showing a phone-ended summary.
    var phoneEndedWorkoutID: String?
    /// False for a stale or duplicate packet. SessionStore must not run any side effect then.
    var accepted: Bool
}

/// The newest phone snapshot applied on this watch. Application contexts and reachable messages
/// can arrive out of order, and a context saved before the current workout can still be the one
/// WatchConnectivity hands us at launch. Applying that older `active: nil` would end the HealthKit
/// workout in the middle of a session, so only snapshots newer than the last applied one may
/// change session state.
struct SnapshotWatermark: Equatable {
    private(set) var latest: Double?

    init(latest: Double? = nil) {
        self.latest = latest?.isFinite == true ? latest : nil
    }

    /// Before the first stamped snapshot, an unstamped one is kept for compatibility with an older
    /// phone. Once a timestamp has been accepted, unstamped packets are stale by definition. A
    /// stamped one must be strictly newer; an equal timestamp is an already-applied duplicate.
    mutating func accept(_ at: Double?) -> Bool {
        guard let at, at.isFinite else { return latest == nil }
        if let latest, at <= latest { return false }
        latest = at
        return true
    }

    static func timestamp(from raw: Any?) -> Double? {
        switch raw {
        case let n as NSNumber: return n.doubleValue
        case let d as Double: return d
        default: return nil
        }
    }
}

typealias Event = [String: Any]

/// How long a HealthKit launch waits for the phone's first WatchConnectivity snapshot before the
/// watch starts its session anyway. A workout already restored locally, or any valid snapshot,
/// ends the wait immediately so the phone's workout and its planned type win when available.
enum LaunchSnapshotWait {
    static let timeout: TimeInterval = 1.5

    static func shouldWait(hasSnapshot: Bool, hasWorkout: Bool, elapsed: TimeInterval) -> Bool {
        !hasSnapshot && !hasWorkout && elapsed < timeout
    }
}

/// What an exercise's page represents in the session right now.
enum EntryStatus: Equatable {
    case current, done, upcoming
}

enum SessionCore {
    /// The range `Text(timerInterval:)` can render for a running countdown. SwiftUI may redraw a
    /// countdown once after its deadline, before the owner clears it; `ClosedRange` traps when
    /// its lower bound is later than its upper bound, so callers must use this guard instead of
    /// constructing `Date()...end` themselves.
    static func countdownRange(end: Date, now: Date = Date()) -> ClosedRange<Date>? {
        guard end > now else { return nil }
        return now...end
    }

    /// The same exercise id can appear in a workout more than once (a repeated catalog movement),
    /// so the entry index is part of the key: set 0 of entry 0 and set 0 of entry 1 are different
    /// sets and must not share a pending tick or a skip.
    static func key(_ exId: String, entry ei: Int, _ si: Int, _ side: String? = nil) -> String {
        side.map { "\(exId)#\(ei)#\(si)#\($0)" } ?? "\(exId)#\(ei)#\(si)"
    }

    /// Moves a state saved before the entry index was in the key ("exId#set", or "exId#set#L/R")
    /// to the current key ("exId#entry#set", plus "#L"/"#R"). A key that cannot be placed on one
    /// entry is dropped: putting it on the wrong entry would tick a set the athlete did not do.
    /// Keys already in the current format are kept as they are.
    static func migrateLegacyKeys(_ s: SessionState) -> SessionState {
        guard let w = s.workout else { return s }
        let byExercise = Dictionary(grouping: w.entries.indices, by: { w.entries[$0].id })

        func migrated(_ old: String) -> String? {
            let parts = old.split(separator: "#", omittingEmptySubsequences: false).map(String.init)
            let side: String? = parts.last == "L" || parts.last == "R" ? parts.last : nil
            let bare = side == nil ? parts : Array(parts.dropLast())
            if bare.count == 3 { return old }                 // current: exId#entry#set(#side)
            guard bare.count == 2, let si = Int(bare[1]),
                  let matches = byExercise[bare[0]], matches.count == 1 else { return nil }
            let ei = matches[0]
            guard w.entries[ei].sets.indices.contains(si) else { return nil }
            if side != nil, w.entries[ei].sets[si].sides == nil { return nil }
            return key(bare[0], entry: ei, si, side)
        }

        var next = s
        next.pending = [:]
        for (old, tick) in s.pending {
            if let new = migrated(old) { next.pending[new] = tick }
        }
        next.skipped = s.skipped?.compactMap(migrated)
        return next
    }

    /// A snapshot from the phone, over what the watch has.
    static func applySnapshot(_ s0: SessionState, _ snap: Snapshot, at: Double? = nil) -> SessionState {
        applySnapshotResult(s0, snap, at: at).state
    }

    static func applySnapshotResult(_ s0: SessionState, _ snap: Snapshot, at: Double? = nil) -> SnapshotApplyResult {
        var watermark = SnapshotWatermark(latest: s0.lastSnapshotAt)
        guard watermark.accept(at) else {
            return SnapshotApplyResult(state: s0, abandonedWorkoutID: nil, phoneEndedWorkoutID: nil, accepted: false)
        }
        var s = s0
        s.lastSnapshotAt = watermark.latest
        s.ready = snap.ready
        if let u = snap.unit { s.unit = u }
        if let r = snap.restSec, r > 0 { s.restSec = r }
        if let st = snap.settings { s.settings = st }

        // A session started here that the phone has not reported back yet stays, whatever it sends.
        let unconfirmed = s.workout?.id != nil && s.workout?.id == s.startedHere
        guard let active = snap.active else {
            // No workout on the phone. An unconfirmed watch start is waiting for the phone to
            // receive its start event; every other local workout has really ended on the phone.
            guard let localID = s.workout?.id else { return SnapshotApplyResult(state: s, abandonedWorkoutID: nil, phoneEndedWorkoutID: nil, accepted: true) }
            if unconfirmed {
                return SnapshotApplyResult(state: s, abandonedWorkoutID: nil, phoneEndedWorkoutID: nil, accepted: true)
            }
            s.workout = nil
            s.pending = [:]
            s.skipped = nil
            s.startedHere = nil
            s.entryIndex = 0
            return SnapshotApplyResult(state: s, abandonedWorkoutID: nil, phoneEndedWorkoutID: localID, accepted: true)
        }
        var next = active
        if let finished = next.id, s.finishedHere.contains(finished) {
            // This watch already finished it. A snapshot from around the finish cannot revive it
            // (the phone had not applied the finish yet), and must not end a different workout
            // that is active here now. The phone stamps snapshots in seconds since 1970 while the
            // finish event carries ms, so the window compares them in the same seconds unit.
            let finishSec = (s.finishedAt?[finished] ?? 0) / 1000
            if let sentAt = at, sentAt > finishSec + 60 {
                s.finishedHere.removeAll { $0 == finished }
                s.finishedAt?[finished] = nil
            } else {
                if s.workout?.id == finished {
                    s.workout = nil
                    s.pending = [:]
                    s.skipped = nil
                    s.startedHere = nil
                    s.entryIndex = 0
                }
                return SnapshotApplyResult(state: s, abandonedWorkoutID: nil, phoneEndedWorkoutID: nil, accepted: true)
            }
        }
        let same = next.id != nil && next.id == s.workout?.id
        let abandoned = !same ? s.workout?.id : nil
        if next.id != nil && next.id == s.startedHere { s.startedHere = nil }
        // A tap here moves the pause on before the phone has heard it. Keep that local state until
        // a snapshot with the same or a newer revision arrives; a phone resume has a newer one.
        if same, let local = s.workout, let localRev = local.pauseRev,
           next.pauseRev == nil || next.pauseRev! < localRev {
            next.pausedAt = local.pausedAt
            next.pausedMs = local.pausedMs
            next.pauseRev = local.pauseRev
            next.pausedBy = local.pausedBy
        }
        if !same {
            // The phone has the one active workout. If this watch also started a different one
            // before the phone confirmed it, the phone's workout wins: no old ticks or skips can
            // be applied to it, and its own position is used.
            s.pending = [:]
            s.skipped = nil
            s.startedHere = nil
            s.entryIndex = next.cur
        }
        // The watch's ticks the phone has not shown yet win; the later tick wins on a set both changed.
        for (ei, e) in next.entries.enumerated() {
            for (si, row) in e.sets.enumerated() {
                let k = key(e.id, entry: ei, si)
                if let p = s.pending[k] {
                    if row.done && (row.at ?? .infinity) >= p.at {
                        s.pending[k] = nil          // the phone has it (or a later change of its own)
                    } else {
                        next.entries[ei].sets[si].done = true
                        next.entries[ei].sets[si].w = p.w ?? row.w
                        next.entries[ei].sets[si].r = p.r ?? row.r
                        if let sec = p.sec { next.entries[ei].sets[si].sec = sec }
                        next.entries[ei].sets[si].at = p.at
                    }
                }
                // A per-side set: each side by itself, the same way.
                for side in ["L", "R"] {
                    let ks = key(e.id, entry: ei, si, side)
                    guard let p = s.pending[ks] else { continue }
                    let have = next.entries[ei].sets[si]
                    if have.sides?[side].done == true && (row.at ?? .infinity) >= p.at {
                        s.pending[ks] = nil
                    } else if have.sides != nil {
                        next.entries[ei].sets[si] = markSide(have, side, w: p.w, r: p.r, at: p.at)
                    } else {
                        s.pending[ks] = nil         // no longer a per-side set on the phone
                    }
                }
            }
        }
        s.entryIndex = min(max(0, s.entryIndex), next.entries.count)   // the last page is Finish
        s.workout = next
        return SnapshotApplyResult(state: s, abandonedWorkoutID: abandoned, phoneEndedWorkoutID: nil, accepted: true)
    }

    /// One side of a per-side set done, the row's own numbers following both sides (as the phone's
    /// syncSideAggregate: reps the sum, weight the heavier, done when both are).
    static func markSide(_ row0: SetRow, _ side: String, w: Double?, r: Double?, at: Double) -> SetRow {
        guard var sides = row0.sides else { return row0 }
        var row = row0
        var one = sides[side]
        one.done = true
        if let w = w { one.w = w }
        if let r = r { one.r = r }
        sides[side] = one
        row.sides = sides
        row.done = sides.L.done && sides.R.done
        row.r = (sides.L.r ?? 0) + (sides.R.r ?? 0)
        row.w = max(sides.L.w ?? 0, sides.R.w ?? 0)
        row.at = max(row0.at ?? 0, at)
        return row
    }

    /// A set ticked here: the state with it done, and the event for the phone. `side` ticks one
    /// side of a per-side set; `sec` is a hold's seconds; a cardio tick carries no numbers.
    static func tick(_ s0: SessionState, entry ei: Int, set si: Int, side: String? = nil, w: Double?, r: Double?, sec: Double? = nil,
                     at: Double, id: String, hr: [String: Double]? = nil, effort: Effort.Rating? = nil) -> (SessionState, Event?) {
        guard var workout = s0.workout, workout.entries.indices.contains(ei), workout.entries[ei].sets.indices.contains(si) else { return (s0, nil) }
        var s = s0
        let e = workout.entries[ei]
        let oneSide = side.flatMap { e.sets[si].sides != nil ? $0 : nil }
        if let side = oneSide {
            workout.entries[ei].sets[si] = markSide(e.sets[si], side, w: w, r: r, at: at)
        } else {
            workout.entries[ei].sets[si].done = true
            if let w = w { workout.entries[ei].sets[si].w = w }
            if let r = r { workout.entries[ei].sets[si].r = r }
            if let sec = sec { workout.entries[ei].sets[si].sec = sec }
            workout.entries[ei].sets[si].at = at
        }
        s.workout = workout
        s.pending[key(e.id, entry: ei, si, oneSide)] = PendingTick(w: w, r: r, at: at, sec: sec)
        var event: Event = [
            "id": id, "type": "setDone", "wid": workout.id ?? "", "exId": e.id,
            "entryIdx": ei, "setIdx": si, "at": at,
        ]
        if let w = w { event["w"] = w }
        if let r = r { event["r"] = r }
        if let sec = sec { event["sec"] = sec }
        if let side = oneSide { event["side"] = side }
        if let hr = hr { event["hr"] = hr }
        // "rpe": 8.5 or "rir": 2, never both; the phone puts it on the set (watch-sync.js effortFrom)
        if let e = effort, Effort.notches(e.kind) != nil { event[e.kind] = e.value }
        return (s, event)
    }

    /// The session paused here, and the event for the phone. A pause already running changes
    /// nothing, so tapping again after a missed snapshot cannot move the clock.
    static func pause(_ s0: SessionState, at: Double, id: String) -> (SessionState, Event?) {
        guard var w = s0.workout, !w.isPaused else { return (s0, nil) }
        var s = s0
        w.pausedAt = at
        w.pausedBy = "watch"
        w.pauseRev = (w.pauseRev ?? 0) + 1
        s.workout = w
        return (s, ["id": id, "type": "pause", "wid": w.id ?? "", "at": at, "pauseRev": w.pauseRev ?? 0])
    }

    /// The session running again: the stretch just ended joins `pausedMs`, and the event tells the
    /// phone which revision it is. Resuming a running session changes nothing.
    static func resume(_ s0: SessionState, at: Double, id: String) -> (SessionState, Event?) {
        guard var w = s0.workout, let pausedAt = w.pausedAt, pausedAt > 0 else { return (s0, nil) }
        var s = s0
        w.pausedMs = (w.pausedMs ?? 0) + max(0, at - pausedAt)
        w.pausedAt = nil
        w.pausedBy = nil
        w.pauseRev = (w.pauseRev ?? 0) + 1
        s.workout = w
        return (s, ["id": id, "type": "resume", "wid": w.id ?? "", "at": at, "pauseRev": w.pauseRev ?? 0])
    }

    /// A set passed over here: not done, the next one comes up (a tap on its dot brings it back).
    static func skip(_ s0: SessionState, entry ei: Int, set si: Int) -> SessionState {
        guard let w = s0.workout, w.entries.indices.contains(ei), w.entries[ei].sets.indices.contains(si) else { return s0 }
        var s = s0
        let k = key(w.entries[ei].id, entry: ei, si)
        s.skipped = Array(Set((s.skipped ?? []) + [k])).sorted()
        return s
    }

    static func isSkipped(_ s: SessionState, _ exId: String, entry ei: Int, _ si: Int) -> Bool {
        s.skipped?.contains(key(exId, entry: ei, si)) ?? false
    }

    /// Where to go after a set of exercise `ei` (set `si`) was done, and whether a rest comes first.
    ///   per-side set with a side to go   the same exercise, no rest (the other side now)
    ///   superset                          the next exercise of the group in turn; the rest only
    ///                                     after the last one of a round
    ///   otherwise                         this exercise while it has sets to do, then the next one
    ///                                     that has; after the last, the Finish page (index = count)
    static func next(after s: SessionState, entry ei: Int, set si: Int) -> (entry: Int, rest: Bool) {
        guard let w = s.workout, w.entries.indices.contains(ei) else { return (s.entryIndex, false) }
        let count = w.entries.count
        if w.entries[ei].sets.indices.contains(si), w.entries[ei].sets[si].sideUp != nil { return (ei, false) }
        let open: (Int) -> Bool = { setIndex(s, entry: $0) != nil }
        if let g = w.entries[ei].group {
            var lo = ei, hi = ei
            while lo > 0 && w.entries[lo - 1].group == g { lo -= 1 }
            while hi + 1 < count && w.entries[hi + 1].group == g { hi += 1 }
            if hi > lo {
                let members = Array(lo...hi)
                let inTurn = members.filter { $0 > ei } + members.filter { $0 <= ei }
                if let n = inTurn.first(where: open) { return (n, n <= ei) }
                if let n = ((hi + 1)..<count).first(where: open) ?? (0..<lo).first(where: open) { return (n, true) }
                return (count, true)
            }
        }
        if open(ei) { return (ei, true) }
        if let n = ((ei + 1)..<count).first(where: open) ?? (0..<ei).first(where: open) { return (n, true) }
        return (count, true)
    }

    /// Whether workout `wid`, gone from this snapshot, was discarded on the phone (not finished):
    /// then nothing of it is saved to Apple Health (#776). An older phone never says: saved, as before.
    static func discarded(_ wid: String?, in snap: Snapshot) -> Bool {
        guard let wid = wid else { return false }
        return snap.discarded?.contains(wid) ?? false
    }

    /// A set the phone ticked, which the watch did not: its heart rate is the watch's to work out
    /// (the phone has no sensor), from the watch session's readings up to `at`.
    struct PhoneTick: Equatable {
        var exId: String
        var entryIdx: Int
        var setIdx: Int
        /// When the phone ticked it (ms since 1970).
        var at: Double
    }

    /// The sets done in `after` and not in `before`, the same workout on both sides, oldest tick
    /// first. A set the watch ticked itself is done in `before` already (tick), so only the phone's
    /// show up here; a set without the phone's `at` is left out (no time to measure up to).
    /// One side of a per-side set counts too: the row's `at` is that side's tick.
    static func phoneTicks(_ before: ActiveWorkout?, _ after: ActiveWorkout?) -> [PhoneTick] {
        guard let b = before, let a = after, let wid = a.id, wid == b.id else { return [] }
        var out: [PhoneTick] = []
        for (ei, e) in a.entries.enumerated() {
            guard b.entries.indices.contains(ei), b.entries[ei].id == e.id else { continue }
            let old = b.entries[ei].sets
            for (si, row) in e.sets.enumerated() {
                guard let at = row.at, old.indices.contains(si) else { continue }
                let was = old[si]
                let newSide = ["L", "R"].contains { row.sides?[$0].done == true && was.sides?[$0].done != true }
                if (row.done && !was.done) || newSide { out.append(PhoneTick(exId: e.id, entryIdx: ei, setIdx: si, at: at)) }
            }
        }
        return out.sorted { $0.at < $1.at }
    }

    /// Of the deleted workouts the phone names, the ones this watch has not taken out of Apple Health
    /// yet (`done`: already removed, or found to have no copy of the watch's). Only workout ids.
    static func healthToDelete(gone: [String]?, done: [String]) -> [String] {
        let seen = Set(done)
        var out: [String] = []
        for id in gone ?? [] where id.hasPrefix("opengym-w-") && !seen.contains(id) && !out.contains(id) { out.append(id) }
        return out
    }

    /// `done` with these ids added, the newest kept (a few hundred is plenty: the phone names at
    /// most the last sixty deletions).
    static func healthDeleted(_ done: [String], adding ids: [String]) -> [String] {
        var out = done.filter { !ids.contains($0) }
        out.append(contentsOf: ids)
        return Array(out.suffix(300))
    }

    /// What the phone is told once they are out, so its own retries of them stop.
    static func healthDeletedEvent(_ ids: [String], id: String) -> Event? {
        ids.isEmpty ? nil : ["id": id, "type": "healthDeleted", "ids": ids]
    }

    /// The weigh-in before a workout started here, for the phone's body weight list.
    static func weighIn(_ w: Double, at: Double, id: String) -> Event? {
        guard w > 0, w < 700 else { return nil }
        return ["id": id, "type": "weighIn", "w": (w * 10).rounded() / 10, "at": at]
    }

    /// A ready session started here, with the body weight just weighed in (or none).
    static func start(_ s0: SessionState, _ session: ReadySession, wid: String, at: Double, id: String, bw: Double? = nil) -> (SessionState, Event) {
        var s = s0
        s.workout = ActiveWorkout(id: wid, name: session.name, unit: s.unit, cur: 0, restSec: s.restSec, rest: nil, entries: session.entries, start: at, healthType: session.healthType)
        s.startedHere = wid
        s.pending = [:]
        s.skipped = nil
        s.entryIndex = 0
        var event: Event = ["id": id, "type": "start", "routineIds": session.routineIds, "wid": wid, "at": at]
        if let bw = bw, bw > 0 { event["bw"] = (bw * 10).rounded() / 10 }
        return (s, event)
    }

    /// The session finished here, or discarded here (the phone drops it unsaved).
    static func finish(_ s0: SessionState, at: Double, id: String, discard: Bool = false) -> (SessionState, Event?) {
        guard let w = s0.workout else { return (s0, nil) }
        var s = s0
        s.workout = nil
        s.pending = [:]
        s.skipped = nil
        s.startedHere = nil
        if let wid = w.id { s.finishedHere = Array((s.finishedHere + [wid]).suffix(5)) }
        if let wid = w.id {
            if s.finishedAt == nil { s.finishedAt = [:] }
            s.finishedAt![wid] = at
        }
        return (s, ["id": id, "type": discard ? "discard" : "finish", "wid": w.id ?? "", "at": at])
    }

    /// The set to do next in an exercise: the one picked, or the first not done.
    static func setIndex(_ s: SessionState, entry ei: Int, picked: Int? = nil) -> Int? {
        guard let w = s.workout, w.entries.indices.contains(ei) else { return nil }
        let sets = w.entries[ei].sets
        if let p = picked, sets.indices.contains(p), !sets[p].done { return p }
        let exId = w.entries[ei].id
        return sets.indices.first { !sets[$0].done && !isSkipped(s, exId, entry: ei, $0) }
    }

    /// The page state shown on the watch. A completed exercise stays done even when its page is
    /// selected; only the selected exercise with a set still to do is current.
    static func entryStatus(_ s: SessionState, entry ei: Int) -> EntryStatus {
        guard let w = s.workout, w.entries.indices.contains(ei) else { return .upcoming }
        let sets = w.entries[ei].sets
        if !sets.isEmpty, sets.allSatisfy({ $0.done }) { return .done }
        if ei == s.entryIndex, setIndex(s, entry: ei) != nil { return .current }
        return .upcoming
    }

    /// Sets done and sets in all, for the complication's ring.
    static func progress(_ s: SessionState) -> (done: Int, total: Int) {
        guard let w = s.workout else { return (0, 0) }
        let all = w.entries.flatMap { $0.sets }.filter { !$0.warmup }
        return (all.filter { $0.done }.count, all.count)
    }

    /// The training time frozen when the workout paused, for the paused screen.
    static func pausedElapsed(_ w: ActiveWorkout?) -> Double? {
        guard let w, let start = w.start, start > 0, let pausedAt = w.pausedAt, pausedAt > 0 else { return nil }
        return max(0, (pausedAt - start - (w.pausedMs ?? 0)) / 1000)
    }

    /// The workout as the summary shows it at its end (here, or on the phone).
    static func summary(_ w: ActiveWorkout, end: Double, startedAt: Double? = nil, endedOnPhone: Bool = false) -> WorkoutSummary {
        var sets = 0, volume = 0.0
        var prs: [String] = []
        for e in w.entries {
            let work = e.sets.filter { !$0.warmup }
            for row in work {
                if let sides = row.sides {
                    for one in [sides.L, sides.R] where one.done { volume += (one.w ?? 0) * (one.r ?? 0) }
                    if row.done { sets += 1 }
                } else if row.done {
                    sets += 1
                    if !e.isTimed && !e.isCardio { volume += (row.w ?? 0) * (row.r ?? 0) }
                }
            }
            if let best = e.best, beatsBest(e, work.filter { $0.done }, best) { prs.append(e.name) }
        }
        let from = w.start ?? startedAt
        let held = (w.pausedMs ?? 0) + (w.pausedAt.map { max(0, end - $0) } ?? 0)
        return WorkoutSummary(name: w.name, unit: w.unit, duration: from.map { max(0, (end - $0 - held) / 1000) },
                              sets: sets, volume: volume, prs: prs, endedOnPhone: endedOnPhone)
    }

    /// Whether one of these done sets beats the best before this workout: a heavier weight (a
    /// lighter one when assisted), or more reps at the same; a longer hold. No history, no PR.
    static func beatsBest(_ e: Entry, _ done: [SetRow], _ best: BestSet) -> Bool {
        if e.isTimed {
            guard let b = best.sec, b > 0 else { return false }
            return done.contains { ($0.sec ?? 0) > b }
        }
        guard !e.isCardio, let bw = best.w, let br = best.r, bw > 0 || br > 0 else { return false }
        let assisted = e.assisted == true
        return done.contains { row in
            let w = row.w ?? 0, r = row.r ?? 0
            if w != bw { return w > 0 && (assisted ? w < bw : w > bw) }
            return r > br
        }
    }
}

/// The end of a workout, on one screen: how long, how much, and what was a first.
struct WorkoutSummary: Codable, Equatable {
    var name: String
    var unit: String
    /// Seconds.
    var duration: Double?
    /// Work sets done (a per-side set once both sides are).
    var sets: Int
    var volume: Double
    /// The exercises with a personal record in this workout.
    var prs: [String]
    var hrAvg: Double?
    var hrMax: Double?
    /// Active kilocalories, from the Apple Health workout.
    var calories: Double?
    /// The phone ended it (finished or discarded there) while the watch had it running.
    var endedOnPhone: Bool
}

/// After the watch turns the page by itself (a superset's partner, the next exercise, the end of a
/// rest), taps are ignored for a second: a second Done meant for the page that just left would
/// otherwise land on the new one and log a set nobody did. A swipe by hand unlocks it at once.
struct TouchLock: Equatable {
    static let seconds: TimeInterval = 1
    private(set) var until = Date.distantPast

    mutating func lock(at t: Date) { until = t.addingTimeInterval(TouchLock.seconds) }
    mutating func unlock() { until = .distantPast }
    func allows(at t: Date) -> Bool { t >= until }
}

/// The 3-2-1 before a workout started on the watch: the heart-rate sensor warms up meanwhile (it
/// needs a few seconds to lock on), so the first set has its heart rate. One second a number.
enum Countdown {
    static let seconds = 3

    /// The number up `elapsed` seconds after the countdown began: 3, 2, 1, then 0 (go).
    static func number(at elapsed: Double) -> Int {
        max(seconds - Int(max(elapsed, 0).rounded(.down)), 0)
    }
}

/// A workout left running (the lifter walked out without Finish): "All done?" after 20 minutes
/// without a logged set, ended and saved on its own after 45, at the time of its last set. Without
/// it the Apple Health session goes on counting minutes and calories for hours. Times in ms.
enum Idle: Equatable {
    case active, ask, end

    static let askAfter: Double = 20 * 60 * 1000
    static let endAfter: Double = 45 * 60 * 1000

    /// When the last set was logged, here or on the phone (one side of a per-side set counts),
    /// else when the workout started; nil when it says neither.
    static func lastSet(_ w: ActiveWorkout) -> Double? {
        let ticks = w.entries.flatMap { $0.sets }.compactMap { $0.at }.filter { $0 > 0 }
        return ticks.max() ?? w.start.flatMap { $0 > 0 ? $0 : nil }
    }

    /// What idle time counts from: the newest of the last set, when this watch picked the workout
    /// up, the last change to it from either side (SessionStore's activityAt, the same one
    /// SensorPlan uses) and a "keep going" answered.
    static func since(lastSet: Double, seen: Double?, activity: Double?, snooze: Double?) -> Double {
        [lastSet, seen ?? 0, activity ?? 0, snooze ?? 0].max() ?? lastSet
    }

    /// `since`: the last thing that counts (the last set, or a "keep going" answered since).
    static func state(since: Double, now: Double) -> Idle {
        let idle = now - since
        return idle >= endAfter ? .end : idle >= askAfter ? .ask : .active
    }
}

/*
 * RPE or RIR on a set, in the scale the phone's profile logs (lib/history.js EFFORT). Empty by
 * default: a set nobody rated sends no effort. The crown walks notches from "not rated" through
 * the scale from easy to hard, so turning up always means harder, whichever the scale:
 *   RPE   –, 6, 6.5, … 10      (half points, as on the phone)
 *   RIR   –, 5, 4, 3, 2, 1, 0  (whole reps left; 0 = failure, the far end of the crown)
 */
enum Effort {
    struct Rating: Equatable {
        var kind: String
        var value: Double
    }

    /// The scale's values from easy to hard, nil for a scale the watch does not know.
    static func notches(_ kind: String?) -> [Double]? {
        switch kind {
        case "rpe": return stride(from: 6.0, through: 10.0, by: 0.5).map { $0 }
        case "rir": return [5, 4, 3, 2, 1, 0]
        default: return nil
        }
    }

    /// "RPE" / "RIR": the phone's own column heading, the same word in every language.
    static func name(_ kind: String) -> String { kind == "rpe" ? "RPE" : "RIR" }

    /// The value at a crown position: 0 is not rated, 1… the scale; past either end it stops there.
    static func value(_ kind: String, at position: Int) -> Double? {
        guard let n = notches(kind), position > 0 else { return nil }
        return n[min(position, n.count) - 1]
    }

    /// Where a value sits on the crown (the nearest notch); 0 for not rated.
    static func position(_ kind: String, of value: Double?) -> Int {
        guard let n = notches(kind), let v = value else { return 0 }
        var best = 0
        for i in n.indices where abs(n[i] - v) < abs(n[best] - v) { best = i }
        return best + 1
    }

    /// Where the editor opens on a set not rated yet: a hard working set, RPE 8 / RIR 2.
    static func start(_ kind: String) -> Double { kind == "rpe" ? 8 : 2 }

    /// The phone's colour band (lib/effort.js EFFORT_BANDS), by RIR: 0 nothing left … 5 easy.
    static func band(_ kind: String, _ value: Double) -> Int {
        let rir = kind == "rpe" ? 10 - value : value
        let tops: [Double] = [0.25, 0.75, 1.5, 2.5, 3.5]
        return tops.firstIndex { rir <= $0 } ?? tops.count
    }
}

/*
 * The weigh-in's crown, in two parts: the whole kilos (or pounds) and the tenth after the point.
 * One crown in tenths moved a whole kilo in a flick and was fiddly to stop on the right one.
 */
enum WeighIn {
    /// 79.4 → (79, 4). Rounded to the tenth first, so 79.95 is (80, 0), never (79, 10).
    static func parts(_ v: Double) -> (whole: Double, tenth: Double) {
        let tenths = (max(0, v) * 10).rounded()
        return ((tenths / 10).rounded(.down), tenths.truncatingRemainder(dividingBy: 10))
    }

    /// (79, 4) → 79.4, on the tenth's grid (no 79.40000001 to send to the phone).
    static func join(whole: Double, tenth: Double) -> Double {
        let t = min(9, max(0, tenth.rounded()))
        return (whole.rounded() * 10 + t) / 10
    }
}
