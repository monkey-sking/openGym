import XCTest
@testable import WatchCore

/// The watch's session against the sync cases (SessionCore's header lists them).
final class SessionCoreTests: XCTestCase {
    func row(_ w: Double, _ r: Double, done: Bool = false, at: Double? = nil) -> SetRow {
        SetRow(w: w, r: r, sec: nil, done: done, warmup: false, at: at)
    }

    func testCountdownRangeStopsAtItsDeadline() {
        let now = Date(timeIntervalSinceReferenceDate: 1_000)
        let end = now.addingTimeInterval(30)
        let range = SessionCore.countdownRange(end: end, now: now)
        XCTAssertEqual(range?.lowerBound, now)
        XCTAssertEqual(range?.upperBound, end)
        XCTAssertNil(SessionCore.countdownRange(end: end, now: end),
                     "redrawing at the deadline must not create a reversed ClosedRange")
        XCTAssertNil(SessionCore.countdownRange(end: end, now: end.addingTimeInterval(0.001)),
                     "a suspended view may redraw after the deadline")
    }

    func workout(_ id: String, sets: [SetRow], cur: Int = 0) -> ActiveWorkout {
        ActiveWorkout(id: id, name: "Push", unit: "kg", cur: cur, restSec: 90, rest: nil,
                      entries: [Entry(id: "0025", name: "Bench Press", mode: "reps", restSec: nil, last: nil, sets: sets),
                                Entry(id: "0426", name: "Overhead Press", mode: "reps", restSec: nil, last: nil, sets: [row(40, 8)])])
    }

    func snap(_ w: ActiveWorkout?) -> Snapshot { Snapshot(v: 1, unit: "kg", restSec: 90, active: w, ready: nil, settings: nil) }

    func testLaunchWaitAllowsAShortSnapshotWindow() {
        XCTAssertTrue(LaunchSnapshotWait.shouldWait(hasSnapshot: false, hasWorkout: false, elapsed: 0.5))
    }

    func testLaunchWaitEndsWhenAWorkoutIsAlreadyRestored() {
        XCTAssertFalse(LaunchSnapshotWait.shouldWait(hasSnapshot: false, hasWorkout: true, elapsed: 0))
    }

    func testLaunchWaitEndsAsSoonAsASnapshotArrives() {
        XCTAssertFalse(LaunchSnapshotWait.shouldWait(hasSnapshot: true, hasWorkout: false, elapsed: 0.1))
    }

    func testLaunchWaitStopsAtItsDeadlineWithoutASnapshot() {
        XCTAssertFalse(LaunchSnapshotWait.shouldWait(hasSnapshot: false, hasWorkout: false, elapsed: LaunchSnapshotWait.timeout))
    }

    func testPicksUpAWorkoutRunningOnThePhoneWhenFirstOpened() {
        let s = SessionCore.applySnapshot(SessionState(), snap(workout("p1", sets: [row(60, 8, done: true, at: 1), row(60, 8)], cur: 1)))
        XCTAssertEqual(s.workout?.id, "p1")
        XCTAssertEqual(s.entryIndex, 1)
        XCTAssertEqual(SessionCore.setIndex(s, entry: 0), 1)
    }

    func testATickStaysUntilTheSnapshotShowsItAndTheLaterTickWins() {
        var s = SessionCore.applySnapshot(SessionState(), snap(workout("p1", sets: [row(60, 8), row(60, 8)])))
        let (t, event) = SessionCore.tick(s, entry: 0, set: 0, w: 62.5, r: 7, at: 1000, id: "e1")
        s = t
        XCTAssertEqual(event?["type"] as? String, "setDone")
        XCTAssertEqual(event?["wid"] as? String, "p1")
        // an older snapshot, sent before the phone applied the tick: the tick stays
        s = SessionCore.applySnapshot(s, snap(workout("p1", sets: [row(60, 8), row(60, 8)])))
        XCTAssertEqual(s.workout?.entries[0].sets[0], row(62.5, 7, done: true, at: 1000))
        XCTAssertNotNil(s.pending["0025#0#0"])
        // the phone changed that set itself earlier: the watch's later tick still wins
        s = SessionCore.applySnapshot(s, snap(workout("p1", sets: [row(55, 5, done: true, at: 500), row(60, 8)])))
        XCTAssertEqual(s.workout?.entries[0].sets[0].w, 62.5)
        // the phone has applied it: confirmed, no longer pending
        s = SessionCore.applySnapshot(s, snap(workout("p1", sets: [row(62.5, 7, done: true, at: 1000), row(60, 8)])))
        XCTAssertNil(s.pending["0025#0#0"])
        // a later change on the phone wins over the watch's tick
        s = SessionCore.tick(s, entry: 0, set: 1, w: 60, r: 8, at: 2000, id: "e2").0
        s = SessionCore.applySnapshot(s, snap(workout("p1", sets: [row(62.5, 7, done: true, at: 1000), row(65, 6, done: true, at: 3000)])))
        XCTAssertEqual(s.workout?.entries[0].sets[1].w, 65)
        XCTAssertNil(s.pending["0025#0#1"])
    }

    func testPauseAndResumeMoveTheClockAndTheRevision() {
        var s = SessionCore.applySnapshot(SessionState(), snap(workout("p1", sets: [row(60, 8)])))
        let (paused, pauseEvent) = SessionCore.pause(s, at: 1_000, id: "p1")
        XCTAssertEqual(pauseEvent?["type"] as? String, "pause")
        XCTAssertEqual(pauseEvent?["pauseRev"] as? Int, 1)
        XCTAssertTrue(paused.workout?.isPaused ?? false)
        XCTAssertEqual(paused.workout?.pausedBy, "watch")
        s = paused
        let (running, resumeEvent) = SessionCore.resume(s, at: 1_700, id: "r1")
        XCTAssertEqual(resumeEvent?["type"] as? String, "resume")
        XCTAssertEqual(resumeEvent?["pauseRev"] as? Int, 2)
        XCTAssertFalse(running.workout?.isPaused ?? true)
        XCTAssertEqual(running.workout?.pausedMs, 700)
    }

    func testAStaleSnapshotCannotUndoAPauseTappedHere() {
        var s = SessionCore.applySnapshot(SessionState(), snap(workout("p1", sets: [row(60, 8)])))
        s = SessionCore.pause(s, at: 1_000, id: "p1").0
        // The phone has not applied the event yet: its snapshot has no pause fields.
        var stale = workout("p1", sets: [row(60, 8)])
        stale.pauseRev = 0
        s = SessionCore.applySnapshot(s, snap(stale))
        XCTAssertTrue(s.workout?.isPaused ?? false, "the watch keeps the pause it just took")
        // The phone applied it: the same revision, still paused.
        var caughtUp = workout("p1", sets: [row(60, 8)])
        caughtUp.pausedAt = 1_000
        caughtUp.pausedBy = "app"
        caughtUp.pauseRev = 1
        s = SessionCore.applySnapshot(s, snap(caughtUp))
        XCTAssertTrue(s.workout?.isPaused ?? false)
        // A phone resume is a newer revision: it wins over the watch's pause.
        var resumed = workout("p1", sets: [row(60, 8)])
        resumed.pausedMs = 500
        resumed.pauseRev = 2
        s = SessionCore.applySnapshot(s, snap(resumed))
        XCTAssertFalse(s.workout?.isPaused ?? true)
        XCTAssertEqual(s.workout?.pausedMs, 500)
    }

    func testSummaryLeavesThePausedStretchOutOfTheDuration() {
        var w = workout("p1", sets: [row(60, 8)])
        w.start = 1_000
        w.pausedMs = 30_000
        let summary = SessionCore.summary(w, end: 91_000)
        XCTAssertEqual(summary.duration, 60)
    }

    func testPausedElapsedFreezesTheTrainingClock() {
        var w = workout("p1", sets: [row(60, 8)])
        w.start = 1_000
        w.pausedAt = 61_000
        w.pausedMs = 5_000
        XCTAssertEqual(SessionCore.pausedElapsed(w), 55)
        w.start = nil
        XCTAssertNil(SessionCore.pausedElapsed(w))
        XCTAssertNil(SessionCore.pausedElapsed(nil))
    }

    func testRelaunchRestoresTheSessionWithItsUnconfirmedTicks() throws {
        var s = SessionCore.applySnapshot(SessionState(), snap(workout("p1", sets: [row(60, 8), row(60, 8)])))
        s = SessionCore.tick(s, entry: 0, set: 0, w: 60, r: 8, at: 1000, id: "e1").0
        let saved = try JSONEncoder().encode(s)
        var back = try JSONDecoder().decode(SessionState.self, from: saved)
        XCTAssertEqual(back, s)
        // the latest context is the old snapshot: the tick survives
        back = SessionCore.applySnapshot(back, snap(workout("p1", sets: [row(60, 8), row(60, 8)])))
        XCTAssertTrue(back.workout?.entries[0].sets[0].done ?? false)
    }

    func testFinishedOnTheWatchStaysFinishedThoughThePhoneHasNotHeard() {
        var s = SessionCore.applySnapshot(SessionState(), snap(workout("p1", sets: [row(60, 8)])))
        let (f, event) = SessionCore.finish(s, at: 5000, id: "f1")
        s = f
        XCTAssertEqual(event?["type"] as? String, "finish")
        XCTAssertNil(s.workout)
        s = SessionCore.applySnapshot(s, snap(workout("p1", sets: [row(60, 8)])))
        XCTAssertNil(s.workout, "a snapshot from before the phone applied the finish does not bring it back")
        s = SessionCore.applySnapshot(s, snap(workout("p2", sets: [row(60, 8)])))
        XCTAssertEqual(s.workout?.id, "p2", "the next workout does show")
    }

    func testDiscardedOnTheWatchTellsThePhoneAndStaysGone() {
        var s = SessionCore.applySnapshot(SessionState(), snap(workout("p1", sets: [row(60, 8)])))
        let (d, event) = SessionCore.finish(s, at: 5000, id: "d1", discard: true)
        s = d
        XCTAssertEqual(event?["type"] as? String, "discard")
        XCTAssertEqual(event?["wid"] as? String, "p1")
        s = SessionCore.applySnapshot(s, snap(workout("p1", sets: [row(60, 8)])))
        XCTAssertNil(s.workout, "a snapshot from before the phone dropped it does not bring it back")
    }

    func testFinishedOnThePhoneEndsItHere() {
        var s = SessionCore.applySnapshot(SessionState(), snap(workout("p1", sets: [row(60, 8)])))
        s = SessionCore.applySnapshot(s, snap(nil))
        XCTAssertNil(s.workout)
        XCTAssertTrue(s.pending.isEmpty)
    }

    func testStartedOnTheWatchStaysUntilThePhoneHasIt() {
        let ready = ReadySession(routineIds: ["r1"], name: "Push", entries: workout("x", sets: [row(60, 8)]).entries)
        var (s, event) = SessionCore.start(SessionState(), ready, wid: "watch-1", at: 100, id: "s1")
        XCTAssertEqual(event["type"] as? String, "start")
        XCTAssertEqual(event["wid"] as? String, "watch-1")
        s = SessionCore.tick(s, entry: 0, set: 0, w: 60, r: 8, at: 200, id: "e1").0
        s = SessionCore.applySnapshot(s, snap(nil))
        XCTAssertEqual(s.workout?.id, "watch-1", "the phone has not heard of it yet")
        s = SessionCore.applySnapshot(s, snap(workout("watch-1", sets: [row(60, 8), row(40, 8)])))
        XCTAssertNil(s.startedHere, "the phone runs it now")
        XCTAssertTrue(s.workout?.entries[0].sets[0].done ?? false, "with the tick made before it heard")
    }

    func testAPhoneWorkoutReplacesAnUnconfirmedWorkoutStartedHere() {
        let ready = ReadySession(routineIds: ["r1"], name: "Push", entries: workout("x", sets: [row(60, 8)]).entries)
        var (s, _) = SessionCore.start(SessionState(), ready, wid: "watch-1", at: 100, id: "s1")
        s = SessionCore.tick(s, entry: 0, set: 0, w: 62.5, r: 7, at: 200, id: "e1").0

        let phone = snap(workout("phone-1", sets: [row(70, 5)], cur: 1))
        let replaced = SessionCore.applySnapshotResult(s, phone, at: 300)
        s = replaced.state
        XCTAssertTrue(replaced.accepted)
        XCTAssertEqual(replaced.abandonedWorkoutID, "watch-1")
        XCTAssertEqual(s.workout?.id, "phone-1")
        XCTAssertNil(s.startedHere)
        XCTAssertTrue(s.pending.isEmpty, "the abandoned watch workout's ticks cannot land on the phone workout")
        XCTAssertFalse(s.workout?.entries[0].sets[0].done ?? true)
        XCTAssertEqual(s.entryIndex, 1)

        let once = s
        let repeated = SessionCore.applySnapshotResult(s, phone, at: 300)
        s = repeated.state
        XCTAssertFalse(repeated.accepted, "the same timestamp is an already-applied duplicate")
        XCTAssertEqual(s, once, "a repeated phone snapshot is idempotent")
        XCTAssertNil(repeated.abandonedWorkoutID, "the old HealthKit session is ended only once")
    }

    func testSnapshotWatermarkAcceptsOnlyNewPackets() {
        var watermark = SnapshotWatermark()
        XCTAssertTrue(watermark.accept(nil), "an old phone may send an unstamped snapshot before any timestamp")
        XCTAssertEqual(watermark.latest, nil)
        XCTAssertTrue(watermark.accept(100))
        XCTAssertEqual(watermark.latest, 100)
        XCTAssertFalse(watermark.accept(100), "an equal timestamp is the same packet")
        XCTAssertFalse(watermark.accept(99), "an older packet cannot roll the watch back")
        XCTAssertFalse(watermark.accept(nil), "an unstamped packet after a timestamp has no ordering evidence")
        XCTAssertTrue(watermark.accept(101))
        XCTAssertEqual(watermark.latest, 101)
    }

    func testAStaleSnapshotCannotEndAWorkoutAfterASetCompletes() {
        let current = workout("p1", sets: [row(60, 8), row(60, 8)])
        let newer = SessionCore.applySnapshotResult(SessionState(), snap(current), at: 200)
        XCTAssertTrue(newer.accepted)
        XCTAssertEqual(newer.state.workout?.id, "p1")

        let stale = SessionCore.applySnapshotResult(newer.state, snap(nil), at: 100)
        XCTAssertFalse(stale.accepted)
        XCTAssertEqual(stale.state, newer.state, "the running workout and watermark stay untouched")
        XCTAssertEqual(stale.state.workout?.id, "p1")
        XCTAssertNil(stale.abandonedWorkoutID)
    }

    func testCompletingOneSetAdvancesWithoutEndingTheWorkout() {
        let s = SessionCore.applySnapshot(SessionState(), snap(workout("p1", sets: [row(60, 8), row(60, 8)])), at: 100)
        let (afterSet, event) = SessionCore.tick(s, entry: 0, set: 0, w: 60, r: 8, at: 200, id: "e1")
        XCTAssertEqual(event?["type"] as? String, "setDone")
        XCTAssertEqual(afterSet.workout?.id, "p1")
        let next = SessionCore.next(after: afterSet, entry: 0, set: 0)
        XCTAssertEqual(next.entry, 0, "the next set is on the same exercise")
        XCTAssertTrue(next.rest)
        XCTAssertNotNil(afterSet.workout, "a set completion is not a workout completion")
    }

    func testTheSnapshotWatermarkSurvivesRelaunch() throws {
        let s = SessionCore.applySnapshot(SessionState(), snap(workout("p1", sets: [row(60, 8)])), at: 200)
        let data = try JSONEncoder().encode(s)
        let back = try JSONDecoder().decode(SessionState.self, from: data)
        XCTAssertEqual(back.lastSnapshotAt, 200)
        let stale = SessionCore.applySnapshotResult(back, snap(nil), at: 100)
        XCTAssertFalse(stale.accepted)
        XCTAssertEqual(stale.state, back)
    }

    /// #799: a run planned on the phone is a run in Apple Health, also when the watch starts it.
    func testTheWorkoutTypeComesWithTheSessionAndAnOlderPhoneSendsNone() throws {
        var ready = ReadySession(routineIds: ["r1"], name: "Run", entries: [])
        ready.healthType = "running"
        XCTAssertEqual(SessionCore.start(SessionState(), ready, wid: "watch-1", at: 100, id: "s1").0.workout?.healthType, "running")
        let old = try JSONDecoder().decode(Snapshot.self, from: Data(#"{"v":1,"active":{"id":"p1","name":"Push","unit":"kg","cur":0,"restSec":90,"entries":[]}}"#.utf8))
        XCTAssertNil(old.active?.healthType)
        let run = try JSONDecoder().decode(Snapshot.self, from: Data(#"{"v":1,"active":{"id":"p1","name":"Run","unit":"kg","cur":0,"restSec":90,"entries":[],"healthType":"running"}}"#.utf8))
        XCTAssertEqual(SessionCore.applySnapshot(SessionState(), run).workout?.healthType, "running")
    }

    func testAnotherWorkoutOnThePhoneStartsClean() {
        var s = SessionCore.applySnapshot(SessionState(), snap(workout("p1", sets: [row(60, 8)])))
        s = SessionCore.tick(s, entry: 0, set: 0, w: 60, r: 8, at: 1, id: "e1").0
        s = SessionCore.applySnapshot(s, snap(workout("p2", sets: [row(70, 5)], cur: 1)))
        XCTAssertEqual(s.workout?.id, "p2")
        XCTAssertFalse(s.workout?.entries[0].sets[0].done ?? true, "an old tick never lands on another workout")
        XCTAssertEqual(s.entryIndex, 1)
    }

    func testProgressCountsWorkSetsOnly() {
        var w = workout("p1", sets: [row(60, 8, done: true, at: 1), row(60, 8)])
        w.entries[0].sets.insert(SetRow(w: 20, r: 10, sec: nil, done: true, warmup: true, at: 1), at: 0)
        let s = SessionCore.applySnapshot(SessionState(), snap(w))
        XCTAssertEqual(SessionCore.progress(s).done, 1)
        XCTAssertEqual(SessionCore.progress(s).total, 3)
    }

    func testTheEntryStatusSeparatesCurrentDoneAndUpcomingPages() {
        var s = SessionCore.applySnapshot(SessionState(), snap(workout("p1", sets: [row(60, 8)])))
        XCTAssertEqual(SessionCore.entryStatus(s, entry: 0), .current)
        XCTAssertEqual(SessionCore.entryStatus(s, entry: 1), .upcoming)

        s = SessionCore.tick(s, entry: 0, set: 0, w: 60, r: 8, at: 1_000, id: "e1").0
        XCTAssertEqual(SessionCore.entryStatus(s, entry: 0), .done,
                       "a completed entry is not current merely because its page is selected")
        XCTAssertEqual(SessionCore.entryStatus(s, entry: 1), .upcoming,
                       "an entry with sets still open is not current until its page is selected")

        s.entryIndex = 1
        XCTAssertEqual(SessionCore.entryStatus(s, entry: 0), .done)
        XCTAssertEqual(SessionCore.entryStatus(s, entry: 1), .current)
    }

    func testReadsASnapshotWithFieldsItDoesNotKnowAndWithoutOptionalOnes() throws {
        let json = #"{"v":1,"future":true,"active":{"id":"p1","name":"Push","unit":"kg","cur":0,"restSec":90,"entries":[{"id":"0025","name":"Bench","mode":"reps","sets":[{"w":60,"r":8,"done":false,"warmup":false,"hr":{"avg":1}}]}]}}"#
        let snap = try JSONDecoder().decode(Snapshot.self, from: Data(json.utf8))
        XCTAssertEqual(SessionCore.applySnapshot(SessionState(), snap).workout?.entries.first?.sets.count, 1)
    }

    // #776: a workout discarded on the phone is not saved to Apple Health; finished, or from an
    // older phone that does not say, it is.
    func testADiscardedWorkoutIsToldApartFromAFinishedOne() throws {
        var gone = snap(nil)
        XCTAssertFalse(SessionCore.discarded("p1", in: gone))
        gone.discarded = ["p0", "p1"]
        XCTAssertTrue(SessionCore.discarded("p1", in: gone))
        XCTAssertFalse(SessionCore.discarded("p2", in: gone))
        XCTAssertFalse(SessionCore.discarded(nil, in: gone))
        let json = #"{"v":1,"active":null,"discarded":["p1"]}"#
        XCTAssertTrue(SessionCore.discarded("p1", in: try JSONDecoder().decode(Snapshot.self, from: Data(json.utf8))))
    }

    // A set ticked on the phone while the watch runs the session got no heart rate.
    func testFindsTheSetsThePhoneTickedButNotTheWatchsOwn() {
        var s = SessionCore.applySnapshot(SessionState(), snap(workout("p1", sets: [row(60, 8), row(60, 8), row(60, 8)])))
        s = SessionCore.tick(s, entry: 0, set: 0, w: 60, r: 8, at: 1000, id: "e1").0
        let before = s.workout
        let phone = workout("p1", sets: [row(60, 8, done: true, at: 1000), row(60, 8, done: true, at: 3000), row(60, 8, done: true)])
        s = SessionCore.applySnapshot(s, snap(phone))
        let ticks = SessionCore.phoneTicks(before, s.workout)
        XCTAssertEqual(ticks, [SessionCore.PhoneTick(exId: "0025", entryIdx: 0, setIdx: 1, at: 3000)],
                       "the watch's own tick and a set without a time are left out")
        XCTAssertEqual(SessionCore.phoneTicks(s.workout, s.workout), [])
        XCTAssertEqual(SessionCore.phoneTicks(before, workout("p2", sets: [row(60, 8, done: true, at: 5)])), [], "another workout")
    }

    func testOneSideTickedOnThePhoneCounts() {
        var w = workout("p1", sets: [row(20, 0)])
        w.entries[0].sets[0].sides = Sides(L: SideRow(w: 20, r: 10, done: false), R: SideRow(w: 20, r: 10, done: false))
        let before = SessionCore.applySnapshot(SessionState(), snap(w)).workout
        var after = w
        after.entries[0].sets[0] = SessionCore.markSide(w.entries[0].sets[0], "L", w: 20, r: 10, at: 2000)
        XCTAssertEqual(SessionCore.phoneTicks(before, after).map(\.at), [2000])
    }

    /// Two catalog entries can share an exercise id (a repeated movement). Set 0 of each is a
    /// different set: a pending tick or a skip on one must not land on the other.
    func testTheSameExerciseIdInTwoEntriesKeepsPendingAndSkippedApart() {
        func repeated() -> ActiveWorkout {
            ActiveWorkout(id: "p1", name: "Push", unit: "kg", cur: 0, restSec: 90, rest: nil,
                          entries: [
                            Entry(id: "0025", name: "Bench Press", mode: "reps", restSec: nil, last: nil, sets: [row(60, 8)]),
                            Entry(id: "0025", name: "Bench Press", mode: "reps", restSec: nil, last: nil, sets: [row(60, 8)]),
                          ])
        }

        var s = SessionCore.applySnapshot(SessionState(), snap(repeated()))
        s = SessionCore.tick(s, entry: 0, set: 0, w: 62.5, r: 7, at: 1000, id: "e1").0
        XCTAssertNotNil(s.pending[SessionCore.key("0025", entry: 0, 0)])
        XCTAssertNil(s.pending[SessionCore.key("0025", entry: 1, 0)])

        s = SessionCore.applySnapshot(s, snap(repeated()))
        XCTAssertTrue(s.workout?.entries[0].sets[0].done ?? false)
        XCTAssertFalse(s.workout?.entries[1].sets[0].done ?? true, "entry 0's tick never lands on entry 1")

        s = SessionCore.skip(s, entry: 1, set: 0)
        XCTAssertFalse(SessionCore.isSkipped(s, "0025", entry: 0, 0))
        XCTAssertTrue(SessionCore.isSkipped(s, "0025", entry: 1, 0))

        s = SessionCore.tick(s, entry: 1, set: 0, w: 70, r: 5, at: 2000, id: "e2").0
        s = SessionCore.applySnapshot(s, snap(repeated()))
        XCTAssertEqual(s.workout?.entries[0].sets[0].w, 62.5)
        XCTAssertEqual(s.workout?.entries[1].sets[0].w, 70)
        XCTAssertTrue(s.workout?.entries[0].sets[0].done ?? false)
        XCTAssertTrue(s.workout?.entries[1].sets[0].done ?? false)
    }

    func testOldKeysMoveToTheKeyWithTheEntryIndex() {
        var s = SessionState()
        s.workout = workout("p1", sets: [row(60, 8), row(60, 8)])
        s.pending = [
            "0025#1": PendingTick(w: 60, r: 8, at: 1000, sec: nil),
            "0025#0#0": PendingTick(w: 62, r: 7, at: 2000, sec: nil),
        ]
        s.skipped = ["0025#1", "0426#0", "0025#0#0"]

        let m = SessionCore.migrateLegacyKeys(s)

        XCTAssertEqual(Set(m.pending.keys), ["0025#0#1", "0025#0#0"])
        XCTAssertEqual(m.pending["0025#0#1"]?.at, 1000)
        XCTAssertEqual(m.pending["0025#0#0"]?.at, 2000)
        XCTAssertEqual(m.skipped, ["0025#0#1", "0426#1#0", "0025#0#0"])
    }

    func testOldKeysThatCannotPickOneEntryAreDroppedAndNewKeysStay() {
        func repeated() -> ActiveWorkout {
            ActiveWorkout(id: "p1", name: "Push", unit: "kg", cur: 0, restSec: 90, rest: nil,
                          entries: [
                            Entry(id: "0025", name: "Bench Press", mode: "reps", restSec: nil, last: nil, sets: [row(60, 8), row(60, 8)]),
                            Entry(id: "0025", name: "Bench Press", mode: "reps", restSec: nil, last: nil, sets: [row(60, 8), row(60, 8)]),
                          ])
        }
        var s = SessionState()
        s.workout = repeated()
        s.pending = [
            "0025#0": PendingTick(w: 60, r: 8, at: 1000, sec: nil),
            "0025#0#L": PendingTick(w: 60, r: 8, at: 1001, sec: nil),
            "0025#1#0": PendingTick(w: 70, r: 5, at: 2000, sec: nil),
        ]
        s.skipped = ["0025#0", "0025#1#0"]

        let m = SessionCore.migrateLegacyKeys(s)

        XCTAssertEqual(Set(m.pending.keys), ["0025#1#0"], "the ambiguous old tick is dropped, the current key kept")
        XCTAssertEqual(m.pending["0025#1#0"]?.at, 2000)
        XCTAssertEqual(m.skipped, ["0025#1#0"])
    }

    func testOldPerSideKeysKeepTheirSide() {
        var s = SessionState()
        s.workout = workout("p1", sets: [row(20, 0), row(20, 0)])
        s.workout?.entries[0].sets[0].sides = Sides(L: SideRow(w: 20, r: 10, done: false),
                                                   R: SideRow(w: 20, r: 10, done: false))
        s.pending = [
            "0025#0#L": PendingTick(w: 20, r: 10, at: 1000, sec: nil),
            "0025#0#0#R": PendingTick(w: 20, r: 10, at: 2000, sec: nil),
        ]

        let m = SessionCore.migrateLegacyKeys(s)

        XCTAssertEqual(Set(m.pending.keys), ["0025#0#0#L", "0025#0#0#R"])
        XCTAssertEqual(m.pending["0025#0#0#L"]?.at, 1000)
        XCTAssertEqual(m.pending["0025#0#0#R"]?.at, 2000)
    }
}
