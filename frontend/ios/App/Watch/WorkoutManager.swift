import Foundation
import HealthKit
#if canImport(WatchKit)
import WatchKit
#endif

#if canImport(WatchKit)
/// A `WKExtendedRuntimeSession` that keeps the watch app frontmost for the whole workout, even when
/// Apple Health write is off or was denied (in which case no HKWorkoutSession exists to pin it).
/// `self-care` is the session category that best matches a self-directed workout and, unlike
/// `.physical-therapy`, requires no extra justification. It is started when a workout goes live and
/// invalidated only when the workout ends or is discarded; phase changes leave it running.
final class ForegroundKeeper: NSObject, WKExtendedRuntimeSessionDelegate {
    private var session: WKExtendedRuntimeSession?
    func start() {
        guard session == nil else { return }
        let s = WKExtendedRuntimeSession()
        s.delegate = self
        session = s
        s.start()
    }
    func stop() {
        session?.invalidate()
        session = nil
    }
    func extendedRuntimeSessionDidStart(_ extendedRuntimeSession: WKExtendedRuntimeSession) {}
    func extendedRuntimeSessionWillExpire(_ extendedRuntimeSession: WKExtendedRuntimeSession) {
        // About to time out: ask for one more, so a long workout stays pinned.
        if session != nil { extendedRuntimeSession.start() }
    }
    func extendedRuntimeSession(_ extendedRuntimeSession: WKExtendedRuntimeSession,
                               didInvalidateWith reason: WKExtendedRuntimeSessionInvalidationReason,
                               error: Error?) {
        if session === extendedRuntimeSession { session = nil }
    }
}
#endif

/*
 * Apple Health on the watch, behind the phone's Apple Health switch (Settings → Data on the iPhone,
 * sent with every snapshot as settings.health): a workout session (of the type the phone planned,
 * strength training unless it says otherwise: a run is a run, #799) as soon as a workout starts
 * here or is picked up from the phone, showing the live heart rate and keeping the watch app
 * running with the wrist down (so the rest still taps the wrist on time), and the workout saved to
 * Apple Health when it ends. Off, nothing of this runs and nothing is asked.
 *
 * The heart rate arrives two ways at once, whichever is first: the workout builder's statistics
 * and an anchored query on heart-rate samples, which carry their own time (the sets' and rests'
 * heart rates are worked out from those times). Until the first reading: "measuring".
 * The permission is asked when the phone's switch turns it on, at the start screen, never in the
 * middle of the first set. A workout started on the iPhone can open the app (HealthKit's
 * startWatchApp, WatchAppDelegate): the session starts then, and gets the workout's id when it comes.
 */
final class WorkoutManager: NSObject, ObservableObject, HKWorkoutSessionDelegate, HKLiveWorkoutBuilderDelegate {
    static let enabledKey = "healthEnabled"

    @Published var enabled: Bool = UserDefaults.standard.bool(forKey: WorkoutManager.enabledKey) {
        didSet { UserDefaults.standard.set(enabled, forKey: WorkoutManager.enabledKey) }
    }
    @Published private(set) var heartRate: Double?
    @Published private(set) var running = false
    /// The last HealthKit lifecycle error, for the hidden watch diagnostic.
    @Published private(set) var lastError: String?
    /// A session runs and no reading has come yet.
    var measuring: Bool { running && heartRate == nil }

    private let store = HKHealthStore()
    private var session: HKWorkoutSession?
    private var builder: HKLiveWorkoutBuilder?
    private var query: HKAnchoredObjectQuery?
    /// Every reading of the session, by its own time, for each set's and rest's heart rate.
    private var samples: [(Date, Double)] = []
    private let bpm = HKUnit.count().unitDivided(by: .minute())
    /// A workout to measure (started here or picked up), even before the permission answer.
    private var wanted = false
    #if canImport(WatchKit)
    /// The safety net when no HKWorkoutSession can run (HealthKit unavailable, or the session was
    /// refused): a frontmost extended runtime session, so the app still does not fall back to the
    /// watch face mid-workout. The HKWorkoutSession (workout-processing) is the real pin and has no
    /// time limit; the extended session is capped (self-care 10 min), so it runs only when needed.
    private let foreground = ForegroundKeeper()
    #endif

    /// Keep the app frontmost for as long as a workout is wanted: an HKWorkoutSession when one is
    /// running, else the extended runtime session. A phase change never calls this with `wanted`
    /// false, so the workout stays pinned from its first second to its end or discard.
    private func syncForeground() {
        #if canImport(WatchKit)
        if wanted && session == nil { foreground.start() } else { foreground.stop() }
        #endif
    }

    /// { avg, max } over a stretch of the session, or nil without readings in it.
    func stats(from start: Date, to end: Date) -> [String: Double]? {
        let inside = samples.filter { $0.0 >= start && $0.0 <= end }.map { $0.1 }
        guard !inside.isEmpty else { return nil }
        let avg = inside.reduce(0, +) / Double(inside.count)
        return ["avg": avg.rounded(), "max": (inside.max() ?? avg).rounded()]
    }

    /// Asks for what the session needs: saving workouts, reading the heart rate.
    func requestAuthorization(_ done: @escaping (Bool) -> Void) {
        guard HKHealthStore.isHealthDataAvailable() else { done(false); return }
        var share: Set<HKSampleType> = [HKObjectType.workoutType()]
        var read: Set<HKObjectType> = [HKObjectType.workoutType()]
        if let hr = HKObjectType.quantityType(forIdentifier: .heartRate) { read.insert(hr) }
        // The calories the workout burned, for the summary at its end (and in Apple Health).
        if let kcal = HKObjectType.quantityType(forIdentifier: .activeEnergyBurned) { share.insert(kcal); read.insert(kcal) }
        store.requestAuthorization(toShare: share, read: read) { ok, _ in
            DispatchQueue.main.async { done(ok) }
        }
    }

    /// "on", "off" or "denied", for the phone's Settings → Apple Watch.
    var status: String {
        guard HKHealthStore.isHealthDataAvailable() else { return "off" }
        if store.authorizationStatus(for: HKObjectType.workoutType()) == .sharingDenied { return "denied" }
        return enabled ? "on" : "off"
    }

    /// The phone's setting, when it sends one: on asks for the permission (once) right away.
    func syncSetting(_ on: Bool?) {
        guard let on = on, on != enabled else { return }
        if on {
            requestAuthorization { ok in
                self.enabled = ok
                if ok && self.wanted { self.start() }
                self.onStatus?()
            }
        } else {
            // Only stop saving to Apple Health; a workout that is running keeps running (measured for
            // the wrist, still pinned frontmost) and is discarded rather than saved at its end.
            enabled = false
            onStatus?()
        }
    }

    /// Told when the status changes (SessionStore reports it to the phone).
    var onStatus: (() -> Void)?

    /// The workout's id, for Apple Health's sync identifier (the phone writes none of its own then).
    private var workoutId: String?
    /// The id the running session carries already.
    private var tagged: String?

    /// One workout in Apple Health, not two: the phone skips writing one with this sync id.
    private func tag() {
        guard let b = builder, let wid = workoutId, tagged != wid else { return }
        tagged = wid
        b.addMetadata([HKMetadataKeySyncIdentifier: "opengym-w-\(wid)", HKMetadataKeySyncVersion: 1]) { _, _ in }
    }

    /// The phone's names for a workout's type (lib/health-connect.js SESSION_TYPES, #799).
    static let activityTypes: [String: HKWorkoutActivityType] = [
        "strength_training": .traditionalStrengthTraining, "walking": .walking, "running": .running,
        "biking_stationary": .cycling, "biking": .cycling, "elliptical": .elliptical, "stair_climbing_machine": .stairClimbing,
        "rowing": .rowing, "jump_rope": .jumpRope, "hiit": .highIntensityIntervalTraining, "mixed_cardio": .mixedCardio,
        "yoga": .yoga, "flexibility": .flexibility, "other_workout": .other,
    ]

    /// A session made and prepared, not started yet (the countdown before a workout started here).
    private var prepared = false

    /// The countdown before a workout started here: the session is made and prepared, which turns
    /// the heart-rate sensor on. It needs a few seconds to lock on, so set 1 has its heart rate.
    func prepare(type: String? = nil) {
        guard session == nil, make(type: type, opened: nil) else { return }
        prepared = true
        session?.prepare()
    }

    /// A workout started here or picked up from the phone: the session starts now (the prepared
    /// one, after a countdown), as the type the phone planned (a run is a run in Apple Health),
    /// else as the type HealthKit opened the app with, else strength training. A session already
    /// running keeps its type.
    func start(workoutId wid: String? = nil, type: String? = nil, opened: HKWorkoutActivityType? = nil) {
        wanted = true
        lastError = nil
        if let wid = wid { workoutId = wid }
        // Already running (opened by the phone before its workout arrived): only the id to add.
        if session != nil && !prepared { tag(); syncForeground(); return }
        guard session != nil || make(type: type, opened: opened), let s = session, let b = builder else {
            // No HKWorkoutSession (HealthKit unavailable or refused): the extended runtime session is
            // the only thing that can still keep the app frontmost.
            syncForeground()
            return
        }
        syncForeground()
        prepared = false
        let now = Date()
        s.startActivity(with: now)
        tagged = nil
        tag()
        b.beginCollection(withStart: now) { [weak self, weak s, weak b] ok, error in
            DispatchQueue.main.async {
                guard let self = self, let s = s, let b = b,
                      s === self.session, b === self.builder else { return }
                guard ok else {
                    self.lastError = error?.localizedDescription ?? "HealthKit could not begin collecting workout data"
                    self.running = false
                    self.heartRate = nil
                    self.paused = false
                    s.end()
                    if s === self.session {
                        self.session = nil
                        self.builder = nil
                        // No usable session after all: fall back to keeping the app frontmost.
                        self.syncForeground()
                    }
                    return
                }
                self.lastError = nil
                self.startQuery(from: now)
                self.running = true
            }
        }
    }

    /// A new session of the planned type and its builder. The session runs even when Apple Health
    /// write is off (it also pins the app frontmost and shows the live heart rate at the wrist); only
    /// saving the workout to Health is gated on `enabled` (see `end`). When HealthKit is unavailable
    /// this returns false and the `ForegroundKeeper` alone keeps the app frontmost.
    private func make(type: String?, opened: HKWorkoutActivityType?) -> Bool {
        guard HKHealthStore.isHealthDataAvailable() else { return false }
        let config = HKWorkoutConfiguration()
        config.activityType = type.flatMap { WorkoutManager.activityTypes[$0] } ?? opened ?? .traditionalStrengthTraining
        config.locationType = .indoor
        do {
            let s = try HKWorkoutSession(healthStore: store, configuration: config)
            let b = s.associatedWorkoutBuilder()
            b.dataSource = HKLiveWorkoutDataSource(healthStore: store, workoutConfiguration: config)
            s.delegate = self
            b.delegate = self
            session = s
            builder = b
            samples = []
            heartRate = nil
            calories = nil
            paused = false
            return true
        } catch {
            session = nil
            builder = nil
            lastError = error.localizedDescription
            return false
        }
    }

    /// Rested for a workout nobody finishes (SensorPlan): the session pauses, which lets the
    /// heart-rate sensor go back to its everyday rate. Nothing is lost: the builder keeps what it
    /// measured, and the workout is still saved when it ends. `resume()` picks it up again.
    private(set) var paused = false

    func pause() {
        // A paused workout is still a workout: keep the app frontmost even if no HKWorkoutSession
        // is running (a workout picked up from the phone while already paused, or Health off).
        syncForeground()
        guard let s = session, !paused, s.state == .running else { return }
        paused = true
        s.pause()
    }

    func resume() {
        guard paused else { return }
        paused = false
        session?.resume()
    }

    /// The app was killed (or crashed) with a workout session running: watchOS kept the session and
    /// hands it back here, with everything it measured. Taken up as if never gone; a session this
    /// launch started meanwhile is dropped (one workout in Apple Health, not two).
    func recover(workoutId wid: String?) {
        guard HKHealthStore.isHealthDataAvailable() else { return }
        store.recoverActiveWorkoutSession { recovered, _ in
            DispatchQueue.main.async {
                guard let s = recovered else { return }
                if let other = self.session, other !== s {
                    other.end()
                    self.builder?.discardWorkout()
                }
                let b = s.associatedWorkoutBuilder()
                b.dataSource = HKLiveWorkoutDataSource(healthStore: self.store, workoutConfiguration: s.workoutConfiguration)
                s.delegate = self
                b.delegate = self
                self.session = s
                self.builder = b
                self.paused = s.state == .paused
                self.wanted = true
                if let wid = wid { self.workoutId = wid }
                self.tagged = nil
                self.tag()
                if let q = self.query { self.store.stop(q) }
                self.startQuery(from: s.startDate ?? Date())
                self.running = s.state == .running || s.state == .paused
                self.syncForeground()
                self.lastError = nil
            }
        }
    }

    /// Takes out of Apple Health the workouts this app saved under these sync ids (workouts deleted
    /// in openGym), with the calories saved along with them. Heart-rate readings are the watch's
    /// sensors' own and stay, as with Apple's Workout app. `done` gets the ids that are settled:
    /// removed, or with no copy of this app's to remove. Nothing settled when Health could not be
    /// read or the delete was refused: the next snapshot tries again.
    /// `keepTrying`: ids of workouts that ran here just now, whose copy may still be on its way
    /// into Health (a workout deleted on the phone while the watch was still saving it): not
    /// settled while no copy is found, so the next snapshot looks again.
    func deleteWorkouts(syncIds ids: [String], keepTrying: Set<String> = [], done: @escaping ([String]) -> Void) {
        guard HKHealthStore.isHealthDataAvailable(), !ids.isEmpty else { done([]); return }
        let predicate = HKQuery.predicateForObjects(withMetadataKey: HKMetadataKeySyncIdentifier, allowedValues: ids)
        let q = HKSampleQuery(sampleType: HKObjectType.workoutType(), predicate: predicate, limit: HKObjectQueryNoLimit, sortDescriptors: nil) { [weak self] _, found, error in
            guard let self = self else { return }
            if error != nil { DispatchQueue.main.async { done([]) }; return }
            let me = Bundle.main.bundleIdentifier ?? ""
            let mine = (found as? [HKWorkout] ?? []).filter { $0.sourceRevision.source.bundleIdentifier == me }
            let held = Set(mine.compactMap { $0.metadata?[HKMetadataKeySyncIdentifier] as? String })
            // Settled without a delete: no copy of this app's, and not one that may still come.
            let nothing = ids.filter { !held.contains($0) && !keepTrying.contains($0) }
            if mine.isEmpty { DispatchQueue.main.async { done(nothing) }; return }
            let group = DispatchGroup()
            if let kcal = HKObjectType.quantityType(forIdentifier: .activeEnergyBurned) {
                for w in mine {
                    group.enter()
                    self.store.deleteObjects(of: kcal, predicate: HKQuery.predicateForObjects(from: w)) { _, _, _ in group.leave() }
                }
            }
            group.notify(queue: .global()) {
                self.store.delete(mine) { ok, _ in
                    DispatchQueue.main.async { done(ok ? nothing + Array(held) : nothing) }
                }
            }
        }
        store.execute(q)
    }

    private func startQuery(from start: Date) {
        guard let type = HKQuantityType.quantityType(forIdentifier: .heartRate) else { return }
        let predicate = HKQuery.predicateForSamples(withStart: start, end: nil, options: .strictStartDate)
        let handler: (HKAnchoredObjectQuery, [HKSample]?, [HKDeletedObject]?, HKQueryAnchor?, Error?) -> Void = { [weak self] _, added, _, _, _ in
            guard let self = self else { return }
            let readings = (added as? [HKQuantitySample] ?? []).map { ($0.endDate, $0.quantity.doubleValue(for: self.bpm)) }
            guard !readings.isEmpty else { return }
            DispatchQueue.main.async { self.add(readings) }
        }
        let q = HKAnchoredObjectQuery(type: type, predicate: predicate, anchor: nil, limit: HKObjectQueryNoLimit, resultsHandler: handler)
        q.updateHandler = handler
        query = q
        store.execute(q)
    }

    /// When the badge last changed: it follows the readings at most every few seconds (a redraw of
    /// the page each time costs battery), sooner when the number really moves.
    private var shownAt = Date.distantPast

    private func add(_ readings: [(Date, Double)]) {
        // Kept in time order by inserting each reading where it belongs: a duplicate (the same reading
        // from the query and from the builder) can then only be the neighbour on either side, instead
        // of a scan of the whole workout's readings and a full sort for every new one.
        for r in readings {
            var lo = 0, hi = samples.count
            while lo < hi { let mid = (lo + hi) / 2; if samples[mid].0 < r.0 { lo = mid + 1 } else { hi = mid } }
            if lo < samples.count && abs(samples[lo].0.timeIntervalSince(r.0)) < 0.5 { continue }
            if lo > 0 && abs(samples[lo - 1].0.timeIntervalSince(r.0)) < 0.5 { continue }
            samples.insert(r, at: lo)
        }
        guard let last = samples.last?.1 else { return }
        let now = Date()
        if heartRate == nil || abs((heartRate ?? 0) - last) >= 5 || now.timeIntervalSince(shownAt) >= 4 {
            if heartRate != last { heartRate = last }
            shownAt = now
        }
    }

    /// The whole session's heart rate and calories, for the summary.
    struct Totals {
        var hrAvg: Double?
        var hrMax: Double?
        var calories: Double?
    }

    /// The workout ended: saved to Apple Health, or dropped when `save` is false. `totals` gets the
    /// session's heart rate and calories (nothing when no session ran). `at`: when it really ended
    /// (a workout left running ends at its last set, not when the watch noticed), else now.
    func end(save: Bool, at: Date? = nil, totals: ((Totals) -> Void)? = nil) {
        wanted = false
        workoutId = nil
        prepared = false
        lastError = nil
        // The workout is over (finished or discarded): release the foreground pin. A phase change
        // does not call this, so the app stays frontmost between sets, rests and holds.
        syncForeground()
        if let q = query { store.stop(q); query = nil }
        let endAt = at ?? Date()
        let all = samples.filter { $0.0 <= endAt }.map { $0.1 }
        let hr = Totals(hrAvg: all.isEmpty ? nil : (all.reduce(0, +) / Double(all.count)).rounded(), hrMax: all.max()?.rounded(), calories: nil)
        guard let s = session, let b = builder else {
            if let totals = totals { DispatchQueue.main.async { totals(Totals()) } }
            return
        }
        s.end()
        // Never before the session's own start (a workout picked up from the phone after its last set).
        // Saved to Apple Health only when the phone's switch is on and the caller asked to save; a
        // workout recorded with the switch off is measured for the wrist but never written to Health.
        let persist = save && enabled
        b.endCollection(withEnd: max(endAt, b.startDate ?? endAt)) { _, _ in
            var out = hr
            if let kcalType = HKQuantityType.quantityType(forIdentifier: .activeEnergyBurned),
               let kcal = b.statistics(for: kcalType)?.sumQuantity()?.doubleValue(for: .kilocalorie()), kcal > 0 {
                out.calories = kcal.rounded()
            }
            if let totals = totals { DispatchQueue.main.async { totals(out) } }
            if persist {
                b.finishWorkout { _, _ in }
            } else {
                b.discardWorkout()
            }
        }
        session = nil
        builder = nil
        paused = false
        DispatchQueue.main.async {
            self.running = false
            self.heartRate = nil
        }
    }

    /* ---------- delegates ---------- */

    func workoutSession(_ workoutSession: HKWorkoutSession, didChangeTo toState: HKWorkoutSessionState,
                        from fromState: HKWorkoutSessionState, date: Date) {
        DispatchQueue.main.async {
            guard workoutSession === self.session else { return }
            switch toState {
            case .notStarted:
                self.running = false
            case .prepared:
                self.running = false
                self.paused = false
            case .running:
                self.running = true
                self.paused = false
                self.lastError = nil
            case .paused:
                self.running = true
                self.paused = true
            case .ended, .stopped:
                if let q = self.query { self.store.stop(q); self.query = nil }
                self.running = false
                self.paused = false
                self.heartRate = nil
                self.session = nil
                self.builder = nil
            @unknown default:
                self.running = false
                self.paused = false
                self.heartRate = nil
            }
        }
    }

    func workoutSession(_ workoutSession: HKWorkoutSession, didFailWithError error: Error) {
        DispatchQueue.main.async {
            guard workoutSession === self.session else { return }
            self.lastError = error.localizedDescription
            self.running = false
            self.paused = false
            self.heartRate = nil
            if let q = self.query { self.store.stop(q); self.query = nil }
            self.session = nil
            self.builder = nil
        }
    }

    func workoutBuilderDidCollectEvent(_ workoutBuilder: HKLiveWorkoutBuilder) {}

    /// Active calories so far, for the workout screen when it shows them (at most every 10 s).
    @Published private(set) var calories: Double?
    private var caloriesAt = Date.distantPast

    func workoutBuilder(_ workoutBuilder: HKLiveWorkoutBuilder, didCollectDataOf collectedTypes: Set<HKSampleType>) {
        if let kcalType = HKQuantityType.quantityType(forIdentifier: .activeEnergyBurned), collectedTypes.contains(kcalType),
           let kcal = workoutBuilder.statistics(for: kcalType)?.sumQuantity()?.doubleValue(for: .kilocalorie()) {
            DispatchQueue.main.async {
                let now = Date()
                guard now.timeIntervalSince(self.caloriesAt) >= 10 || self.calories == nil else { return }
                self.caloriesAt = now
                let rounded = kcal.rounded()
                if self.calories != rounded { self.calories = rounded }
            }
        }
        guard let hrType = HKQuantityType.quantityType(forIdentifier: .heartRate),
              collectedTypes.contains(hrType),
              let stats = workoutBuilder.statistics(for: hrType),
              let value = stats.mostRecentQuantity()?.doubleValue(for: bpm) else { return }
        let at = stats.mostRecentQuantityDateInterval()?.end ?? Date()
        DispatchQueue.main.async { self.add([(at, value)]) }
    }
}
