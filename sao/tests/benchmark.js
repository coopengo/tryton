/* This file is part of Tryton.  The COPYRIGHT file at the top level of
   this repository contains the full copyright notices and license terms. */

/* Unit tests of the pure helpers of the benchmark plugin: Sao.Benchmark.Stats,
   the serialization side of Sao.Benchmark.Csv, and the resource timing
   correlation of Sao.Benchmark.Probe -- the three parts that decide something
   without needing a session, an RPC transport or a laid out DOM.  The rest of
   the Probe, the detached screen Driver and the file delivery need all three,
   and tests/ carries no mock infrastructure for any of them: they are covered
   by the browser verification protocol of the task instead. */
(function() {
    'use strict';

    var Stats = Sao.Benchmark.Stats;
    var Csv = Sao.Benchmark.Csv;
    var Probe = Sao.Benchmark.Probe;

    // One RPC attempt as the probe holds it while it waits for its resource
    // timing entry.  _t_end is null while the call is in flight.
    var attempt = function(method, t_start, t_end) {
        return {
            rpc_method: method,
            causes: [],
            _t_start: t_start,
            _t_end: (t_end === undefined) ? null : t_end
        };
    };

    // One PerformanceResourceTiming.  The name keeps the url fragment, which
    // is where rpc.js:188 writes the method; `bare` builds the entry a browser
    // that strips it would report.
    var entry = function(method, start, duration) {
        return {
            name: 'http://host/db/rpc/' + (method ? '#' + method : ''),
            initiatorType: 'xmlhttprequest',
            startTime: start,
            duration: duration,
            responseEnd: start + duration
        };
    };

    // The test the fix replaced: containment of the entry start in the
    // candidate's transport window, which for a call still in flight ran to
    // the present instant.  Kept here so the defect stays reproducible.
    var containment_accepts = function(entry_, attempt_, t_now) {
        var upper = (attempt_._t_end === null) ? t_now : attempt_._t_end;
        return (entry_.startTime >= attempt_._t_start - 5) &&
            (entry_.startTime <= upper + 5);
    };

    // 1..n, so a series of a known size has known order statistics.
    var seq = function(n) {
        var values = [];
        for (var i = 1; i <= n; i++) {
            values.push(i);
        }
        return values;
    };

    // Interpolated values are not exact in binary floating point.
    var close = function(actual, expected, message) {
        QUnit.assert.ok(
            (typeof actual == 'number') && (Math.abs(actual - expected) < 1e-9),
            message + ' (got ' + actual + ', expected ' + expected + ')');
    };

    var DECADES = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

    QUnit.test('Benchmark Stats reports the true extremes', function() {
        // Functional criterion 5.  The server aggregates with do_bench
        // (bench.py:29-38), which sorts, drops the ends and then indexes an
        // already truncated list: what it publishes as `maximum` is the third
        // largest value and even its `slowest` is only the second largest.
        // The latency tail is the only reliable signature of a WAF, so that
        // truncation must NOT be reproduced here.
        var sample = [1, 2, 3, 4, 100];
        QUnit.assert.strictEqual(Stats.max(sample), 100,
            'max is the largest value observed');
        QUnit.assert.notStrictEqual(Stats.max(sample), 4,
            'max is not the second largest (do_bench `slowest`)');
        QUnit.assert.notStrictEqual(Stats.max(sample), 3,
            'max is not the third largest (do_bench `maximum`)');
        QUnit.assert.strictEqual(Stats.min(sample), 1,
            'min is the smallest value observed');
        QUnit.assert.notStrictEqual(Stats.min(sample), 2,
            'min is not the second smallest');
        // A default JS sort is lexicographic, which would answer 9 here.
        QUnit.assert.strictEqual(Stats.max([9, 10, 100]), 100,
            'the sort is numeric, not lexicographic');
        QUnit.assert.strictEqual(Stats.min([9, 10, 100]), 9,
            'min is numeric too');
        QUnit.assert.strictEqual(Stats.summary(sample).max, 100,
            'the summary carries the same true maximum');
    });

    QUnit.test('Benchmark Stats central tendency and dispersion', function() {
        // mean 3, median 3, sum of squared deviations 16 over n - 1 = 4,
        // so the sample standard deviation is exactly 2.
        var sample = [1, 1, 3, 5, 5];
        QUnit.assert.strictEqual(Stats.mean(sample), 3, 'mean');
        QUnit.assert.strictEqual(Stats.median(sample), 3, 'median');
        QUnit.assert.strictEqual(Stats.stddev(sample), 2,
            'sample standard deviation, over n - 1');
        QUnit.assert.strictEqual(Stats.mad(sample), 2,
            'median absolute deviation');
        QUnit.assert.strictEqual(Stats.count(sample), 5, 'count');
        QUnit.assert.strictEqual(Stats.median([1, 2, 3]), 2,
            'median of an odd count is the middle observation');
        QUnit.assert.strictEqual(Stats.median([1, 2, 3, 4]), 2.5,
            'median of an even count is the mean of the two middle ones');
    });

    QUnit.test('Benchmark Stats resists outliers and stray values',
        function() {
            var sample = [1, 2, 3, 4, 100];
            QUnit.assert.strictEqual(Stats.median(sample), 3,
                'the median ignores the outlier');
            QUnit.assert.strictEqual(Stats.mad(sample), 1,
                'the MAD ignores it too, which is why it is reported');
            QUnit.assert.ok(Stats.stddev(sample) > 40,
                'while the standard deviation is carried away by it');
            // A single NaN or Infinity would otherwise poison every figure
            // derived from the series.
            QUnit.assert.strictEqual(Stats.max([1, NaN, 5, Infinity]), 5,
                'NaN and Infinity are dropped, not propagated');
            QUnit.assert.strictEqual(Stats.count([1, '2', NaN]), 2,
                'numeric strings are kept, non-finite values are not');
        });

    QUnit.test('Benchmark Stats on an empty series', function() {
        // null, never 0: an empty series has no minimum, and a 0 would be
        // averaged in by any spreadsheet.
        QUnit.assert.strictEqual(Stats.min([]), null, 'min');
        QUnit.assert.strictEqual(Stats.max([]), null, 'max');
        QUnit.assert.strictEqual(Stats.mean([]), null, 'mean');
        QUnit.assert.strictEqual(Stats.median([]), null, 'median');
        QUnit.assert.strictEqual(Stats.stddev([]), null, 'stddev');
        QUnit.assert.strictEqual(Stats.mad([]), null, 'mad');
        QUnit.assert.strictEqual(Stats.percentile([], 0.5), null, 'percentile');
        QUnit.assert.strictEqual(Stats.percentile_r7([], 0.5), null,
            'percentile R-7');
        QUnit.assert.strictEqual(Stats.median_ci95([]), null,
            'median confidence interval');
        QUnit.assert.strictEqual(Stats.summary([]).n, 0, 'summary count');
        QUnit.assert.strictEqual(Stats.min(null), null,
            'a missing series is not an error either');
    });

    QUnit.test('Benchmark Stats on a single observation', function() {
        QUnit.assert.strictEqual(Stats.min([42]), 42, 'min');
        QUnit.assert.strictEqual(Stats.max([42]), 42, 'max');
        QUnit.assert.strictEqual(Stats.mean([42]), 42, 'mean');
        QUnit.assert.strictEqual(Stats.median([42]), 42, 'median');
        QUnit.assert.strictEqual(Stats.percentile([42], 0.5), 42, 'p50');
        QUnit.assert.strictEqual(Stats.percentile_r7([42], 0.9), 42,
            'R-7 has nothing to interpolate between');
        QUnit.assert.strictEqual(Stats.stddev([42]), null,
            'the sample standard deviation is undefined on one observation');
        QUnit.assert.strictEqual(Stats.mad([42]), 0, 'the MAD is 0');
        QUnit.assert.strictEqual(Stats.median_ci95([42]), null,
            'no confidence interval on one observation');
    });

    QUnit.test('Benchmark Stats on identical values', function() {
        var sample = [7, 7, 7, 7, 7, 7];
        QUnit.assert.strictEqual(Stats.min(sample), 7, 'min');
        QUnit.assert.strictEqual(Stats.max(sample), 7, 'max');
        QUnit.assert.strictEqual(Stats.stddev(sample), 0, 'stddev is 0');
        QUnit.assert.strictEqual(Stats.mad(sample), 0, 'mad is 0');
        var ci = Stats.median_ci95(sample);
        QUnit.assert.strictEqual(ci.low, 7, 'the interval collapses, low');
        QUnit.assert.strictEqual(ci.high, 7, 'the interval collapses, high');
    });

    QUnit.test('Benchmark Stats percentile by nearest rank', function() {
        // index = ceil(p * N) over the sorted sample: SLO semantics, the
        // value reported was actually observed rather than interpolated.
        QUnit.assert.strictEqual(Stats.percentile(DECADES, 0.5), 50, 'p50');
        QUnit.assert.strictEqual(Stats.percentile(DECADES, 0.75), 80, 'p75');
        QUnit.assert.strictEqual(Stats.percentile(DECADES, 0.9), 90, 'p90');
        QUnit.assert.strictEqual(Stats.percentile(DECADES, 0.25), 30, 'p25');
        // Bounds: ceil(0 * N) is 0 and ceil(1 * N) is N, both clamped into
        // the sample rather than read out of it.
        QUnit.assert.strictEqual(Stats.percentile(DECADES, 0), 10,
            'p = 0 clamps to the first order statistic');
        QUnit.assert.strictEqual(Stats.percentile(DECADES, 1), 100,
            'p = 1 is the last order statistic');
        DECADES.forEach(function(value) {
            QUnit.assert.ok(DECADES.indexOf(
                Stats.percentile(DECADES, value / 100)) >= 0,
            'every nearest rank percentile is an observed value');
        });
    });

    QUnit.test('Benchmark Stats percentile by R-7 interpolation', function() {
        // Same data, numpy / Excel convention: h = (N - 1) * p, then linear
        // interpolation.  Emitted next to the nearest rank so the figures can
        // be compared with what another tool produces on the same series.
        QUnit.assert.strictEqual(Stats.percentile_r7(DECADES, 0.5), 55, 'p50');
        QUnit.assert.strictEqual(Stats.percentile_r7(DECADES, 0.75), 77.5,
            'p75');
        QUnit.assert.strictEqual(Stats.percentile_r7(DECADES, 0.25), 32.5,
            'p25');
        close(Stats.percentile_r7(DECADES, 0.9), 91, 'p90');
        QUnit.assert.strictEqual(Stats.percentile_r7(DECADES, 0), 10,
            'p = 0 is the first order statistic');
        QUnit.assert.strictEqual(Stats.percentile_r7(DECADES, 1), 100,
            'p = 1 is the last one');
        QUnit.assert.notStrictEqual(
            Stats.percentile_r7(DECADES, 0.25),
            Stats.percentile(DECADES, 0.25),
            'the two conventions really do differ on the same series');
    });

    QUnit.test('Benchmark Stats confidence interval on the median',
        function() {
            // Order statistics, binomial: no normality assumed, because
            // latency distributions are skewed and often bimodal.
            QUnit.assert.strictEqual(Stats.median_ci95(seq(5)), null,
                'below n = 6 no distribution-free 95% interval exists');
            var ci6 = Stats.median_ci95(seq(6));
            QUnit.assert.strictEqual(ci6.rank_low, 1, 'n = 6, lower rank');
            QUnit.assert.strictEqual(ci6.rank_high, 6, 'n = 6, upper rank');
            QUnit.assert.strictEqual(ci6.low, 1, 'n = 6, lower bound');
            QUnit.assert.strictEqual(ci6.high, 6, 'n = 6, upper bound');
            QUnit.assert.strictEqual(ci6.coverage, 0.96875,
                'n = 6, coverage 1 - 2 * 0.5^6');
            QUnit.assert.strictEqual(ci6.exact, true, 'n = 6, exact binomial');
            // Textbook value: for n = 20 the distribution-free 95% interval
            // on the median runs from the 6th to the 15th order statistic.
            var ci20 = Stats.median_ci95(seq(20));
            QUnit.assert.strictEqual(ci20.rank_low, 6, 'n = 20, lower rank');
            QUnit.assert.strictEqual(ci20.rank_high, 15, 'n = 20, upper rank');
            QUnit.assert.strictEqual(ci20.low, 6, 'n = 20, lower bound');
            QUnit.assert.strictEqual(ci20.high, 15, 'n = 20, upper bound');
            QUnit.assert.ok(ci20.coverage >= 0.95,
                'the interval covers at least 95%');
            close(ci20.coverage, 0.95861053466796875, 'n = 20, coverage');
            // Past 1000, 0.5^n underflows and a normal approximation takes
            // over; the result must say so rather than pretend to be exact.
            var big = Stats.median_ci95(seq(1001));
            QUnit.assert.strictEqual(big.exact, false,
                'the normal approximation is flagged as not exact');
            QUnit.assert.ok(big.low < big.high, 'and still brackets the median');
        });

    QUnit.test('Benchmark Stats gates the percentiles it will publish',
        function() {
            // Functional criterion 6.  A p99 on 100 samples is the 99th order
            // statistic out of 100: one observation away from the maximum,
            // with no statistical content.
            QUnit.assert.strictEqual(Stats.publishable(0.5, 1), true,
                'p50 is publishable from the first sample');
            QUnit.assert.strictEqual(Stats.publishable(0.75, 1), true,
                'p75 too');
            QUnit.assert.strictEqual(Stats.publishable(0.9, 1), true,
                'p90 too');
            QUnit.assert.strictEqual(Stats.publishable(0.95, 199), false,
                'p95 is not publishable at n = 199');
            QUnit.assert.strictEqual(Stats.publishable(0.95, 200), true,
                'p95 becomes publishable at n = 200');
            QUnit.assert.strictEqual(Stats.publishable(0.99, 999), false,
                'p99 is not publishable at n = 999');
            QUnit.assert.strictEqual(Stats.publishable(0.99, 1000), true,
                'p99 becomes publishable at n = 1000');
        });

    QUnit.test('Benchmark Stats summary leaves ungated percentiles empty',
        function() {
            // Functional criterion 6, as the aggregate row carries it.  The
            // cell must be the EMPTY STRING: null or 0 would be averaged in
            // by a spreadsheet, which is exactly the mistake being avoided.
            var below = Stats.summary(seq(199));
            QUnit.assert.strictEqual(below.n, 199, 'n = 199');
            QUnit.assert.strictEqual(typeof below.p50, 'number',
                'p50 is published');
            QUnit.assert.strictEqual(typeof below.p75, 'number',
                'p75 is published');
            QUnit.assert.strictEqual(typeof below.p90, 'number',
                'p90 is published');
            QUnit.assert.strictEqual(below.p95, '',
                'p95 is an empty cell at n = 199');
            QUnit.assert.strictEqual(below.p95_r7, '',
                'and so is its R-7 twin');
            QUnit.assert.strictEqual(below.p99, '',
                'p99 is an empty cell at n = 199');

            var at200 = Stats.summary(seq(200));
            QUnit.assert.strictEqual(typeof at200.p95, 'number',
                'p95 is published at n = 200');
            QUnit.assert.strictEqual(typeof at200.p95_r7, 'number',
                'and so is its R-7 twin');
            QUnit.assert.strictEqual(at200.p99, '',
                'p99 is still an empty cell at n = 200');

            QUnit.assert.strictEqual(Stats.summary(seq(999)).p99, '',
                'p99 is an empty cell at n = 999');
            var at1000 = Stats.summary(seq(1000));
            QUnit.assert.strictEqual(typeof at1000.p99, 'number',
                'p99 is published at n = 1000');
            QUnit.assert.strictEqual(at1000.p99, 990,
                'and its nearest rank value is ceil(0.99 * 1000)');
            QUnit.assert.strictEqual(at1000.max, 1000,
                'next to the true maximum');
        });

    QUnit.test('Benchmark Csv formats numbers with a decimal point',
        function() {
            // Functional criterion 7.  This test is written to FAIL if anyone
            // ever routes these numbers through Sao.Window.Export.format_row
            // (window.js:2611), which localizes via toLocaleString: in French
            // that yields a decimal comma and a thousands separator, and the
            // file stops being readable as numbers.
            QUnit.assert.ok(
                (1234.5678).toLocaleString('fr-FR').indexOf(',') >= 0,
                'the French locale really does use a decimal comma,' +
                ' so this test has something to catch');
            QUnit.assert.strictEqual(Csv.ms(1234.5678), '1234.568',
                'milliseconds keep three decimals and a point');
            QUnit.assert.ok(/^[0-9.]+$/.test(Csv.ms(1234.5678)),
                'nothing but digits and a point: no comma, no group separator');
            QUnit.assert.strictEqual(Csv.num(0.5), '0.5',
                'without a digit count the number is written as it stands');
            QUnit.assert.strictEqual(Csv.num(2.5, 2), '2.50',
                'with a digit count it is padded');
            QUnit.assert.strictEqual(Csv.num(0), '0',
                'zero is a value, not an empty cell');
            QUnit.assert.strictEqual(Csv.ms(null), '', 'null is an empty cell');
            QUnit.assert.strictEqual(Csv.ms(undefined), '',
                'undefined is an empty cell');
            QUnit.assert.strictEqual(Csv.ms(''), '',
                'an already empty cell stays empty');
            QUnit.assert.strictEqual(Csv.ms(NaN), '',
                'NaN is an empty cell, never the string "NaN"');
            QUnit.assert.strictEqual(Csv.ms(Infinity), '',
                'and so is Infinity');
        });

    QUnit.test('Benchmark Csv renders cells without losing zero or false',
        function() {
            QUnit.assert.strictEqual(Csv.cell(null), '', 'null');
            QUnit.assert.strictEqual(Csv.cell(undefined), '', 'undefined');
            QUnit.assert.strictEqual(Csv.cell(true), 'true', 'true');
            QUnit.assert.strictEqual(Csv.cell(false), 'false',
                'false is written, not blanked');
            QUnit.assert.strictEqual(Csv.cell(0), '0',
                'zero is written, not blanked');
            QUnit.assert.strictEqual(Csv.cell(''), '', 'empty string');
            QUnit.assert.strictEqual(Csv.cell('text'), 'text', 'text');
            // Both are keyed on the same Windows test, so a file delivered
            // with a semicolon always carries the BOM Excel needs.
            QUnit.assert.strictEqual(Csv.delimiter() == ';', Csv.want_bom(),
                'the semicolon delimiter and the BOM travel together');
        });

    QUnit.test('Benchmark Csv writes the header as the first data row',
        function() {
            // House pattern of tab.js:1810: Sao passes the header as a data
            // row and never uses the `fields` key of Papa.unparse.
            var columns = [
                {name: 'alpha', get: function(record) {
                    return Csv.cell(record.alpha);
                }},
                {name: 'beta', get: function(record) {
                    return Csv.cell(record.beta);
                }}
            ];
            var options = {delimiter: ',', bom: false};
            var csv = Csv.serialize(
                columns, [{alpha: '1', beta: '2'}], options);
            QUnit.assert.strictEqual(csv, 'alpha,beta\r\n1,2',
                'header row then data row');
            QUnit.assert.strictEqual(
                Csv.serialize(columns, [], options), 'alpha,beta',
                'the header is emitted even with no record');
            QUnit.assert.strictEqual(
                Csv.serialize(columns, null, options), 'alpha,beta',
                'a missing record list is not an error');
            QUnit.assert.strictEqual(
                Csv.serialize(columns, [{alpha: 'x,y', beta: ''}], options),
                'alpha,beta\r\n"x,y",',
                'a field holding the delimiter is quoted, an empty one stays' +
                ' empty');
            QUnit.assert.strictEqual(
                Csv.serialize(columns, [{alpha: 'he said "hi"', beta: 'z'}],
                    options),
                'alpha,beta\r\n"he said ""hi""",z',
                'quotes are doubled');
            QUnit.assert.strictEqual(
                Csv.serialize(columns, [{alpha: 'x;y', beta: '2'}],
                    {delimiter: ';', bom: false}),
                'alpha;beta\r\n"x;y";2',
                'the semicolon delimiter quotes on the semicolon instead');
            QUnit.assert.strictEqual(
                Csv.serialize(columns, [], {delimiter: ',', bom: true}),
                Sao.BOM_UTF8 + 'alpha,beta',
                'the BOM is prepended when asked for');
        });

    QUnit.test('Benchmark Csv aggregates by scenario, metric and regime',
        function() {
            var sample = function(over) {
                return jQuery.extend({
                    kind: 'phase', scenario: 'Contract', phase: 'search',
                    regime: 'cold', arm: 'direct', warmup: false,
                    served_from_cache: false, causes: [], duration_ms: 10
                }, over);
            };
            var campaign = {
                run_id: 'R1',
                meta: {run_id: 'R1', arm: 'direct'},
                samples: [
                    sample({duration_ms: 10}),
                    sample({duration_ms: 20}),
                    sample({duration_ms: 30}),
                    // Measured and marked, excluded from the aggregates: it
                    // stays in the raw file, it must not move the median.
                    sample({duration_ms: 9999, warmup: true}),
                    // Never reached the server, so it measures nothing about
                    // the network: counted apart, not aggregated.
                    sample({duration_ms: 8888, served_from_cache: true}),
                    // A failed scenario must not skew the others.
                    sample({duration_ms: 7777, causes: ['scenario_failed']}),
                    sample({phase: 'tree_construct', duration_ms: 5}),
                    sample({regime: 'warm', duration_ms: 1}),
                    sample({kind: 'rpc', phase: '', duration_ms: 40,
                        rpc_method: 'model.contract.search'})
                ]
            };
            var rows = Csv.aggregate(campaign);
            QUnit.assert.strictEqual(rows.length, 4,
                'one row per scenario x metric x regime');
            var search = rows[0];
            QUnit.assert.strictEqual(search.phase, 'search', 'first metric');
            QUnit.assert.strictEqual(search.regime, 'cold', 'cold regime');
            QUnit.assert.strictEqual(search.n, 3,
                'only the three valid measured values are aggregated');
            QUnit.assert.strictEqual(search.median, 20, 'median of 10, 20, 30');
            QUnit.assert.strictEqual(search.max, 30,
                'the warmup value is not the maximum');
            QUnit.assert.strictEqual(search.n_cached, 1, 'cached calls counted');
            QUnit.assert.strictEqual(search.n_invalid, 1,
                'invalidated samples counted');
            QUnit.assert.strictEqual(search.run_id, 'R1', 'run id carried');
            QUnit.assert.strictEqual(search.arm, 'direct', 'arm carried');
            QUnit.assert.strictEqual(rows[1].phase, 'tree_construct',
                'a second phase is its own row');
            QUnit.assert.strictEqual(rows[2].regime, 'warm',
                'the warm regime is reported separately, never merged');
            QUnit.assert.strictEqual(rows[3].phase,
                'rpc:model.contract.search',
                'an RPC row carries its method in the phase column');
            QUnit.assert.strictEqual(rows[3].kind, 'rpc', 'and its kind');
            QUnit.assert.strictEqual(Csv.aggregate({}).length, 0,
                'an empty campaign aggregates to nothing');
        });

    QUnit.test('Benchmark Csv raw rows carry the server join keys',
        function() {
            // The positional join with the trytond.rpc.performance log is
            // keyed on (rpc_method, seq); rpc_id stays the client side key.
            var header = Csv.build_raw(
                {run_id: 'R1', meta: {}, samples: []},
                {delimiter: ',', bom: false}).split(',');
            ['rpc_method', 'srv_model', 'srv_method', 'seq', 'rpc_id',
                'regime', 'scenario', 'iteration', 'warmup', 'arm',
                'rt_ttfb_ms', 'next_hop_protocol', 'valid', 'invalid_causes']
                .forEach(function(name) {
                    QUnit.assert.ok(header.indexOf(name) >= 0,
                        'bench_raw.csv carries the ' + name + ' column');
                });
            var csv = Csv.build_raw({
                run_id: 'R1',
                meta: {},
                samples: [{
                    run_id: 'R1', arm: 'direct', regime: 'cold',
                    scenario: 'Contract', iteration: 0, warmup: false,
                    kind: 'rpc', phase: '',
                    rpc_method: 'model.contract.search',
                    srv_model: 'contract', srv_method: 'search',
                    seq: 0, rpc_id: 7, attempt: 1,
                    served_from_cache: false, sync: false,
                    duration_ms: 12.3456, causes: []
                }, {
                    // A call the server never saw keeps an EMPTY seq:
                    // consuming one would shift the whole positional join.
                    run_id: 'R1', kind: 'rpc', rpc_method: 'model.x.y',
                    seq: null, rpc_id: null, served_from_cache: true,
                    causes: []
                }]
            }, {delimiter: ',', bom: false}).split('\r\n');
            var first = csv[1].split(',');
            QUnit.assert.strictEqual(first[header.indexOf('seq')], '0',
                'seq 0 is written, not blanked');
            QUnit.assert.strictEqual(first[header.indexOf('rpc_id')], '7',
                'rpc_id is written');
            QUnit.assert.strictEqual(first[header.indexOf('duration_ms')],
                '12.346', 'durations keep three decimals and a point');
            QUnit.assert.strictEqual(first[header.indexOf('valid')], 'true',
                'a sample with no invalidating cause is valid');
            var second = csv[2].split(',');
            QUnit.assert.strictEqual(second[header.indexOf('seq')], '',
                'a cached call consumes no seq');
            QUnit.assert.strictEqual(
                second[header.indexOf('served_from_cache')], 'true',
                'and says so');
        });

    QUnit.test('Benchmark Csv builds the three files under one run id',
        function() {
            var files = Csv.files({
                run_id: 'R1',
                meta: {run_id: 'R1', arm: 'direct'},
                samples: []
            }, {delimiter: ',', bom: false});
            QUnit.assert.strictEqual(files.length, 3, 'three files');
            QUnit.assert.strictEqual(files[0].name, 'bench_meta_R1.csv',
                'metadata file');
            QUnit.assert.strictEqual(files[1].name, 'bench_raw_R1.csv',
                'raw file');
            QUnit.assert.strictEqual(files[2].name, 'bench_agg_R1.csv',
                'aggregate file');
            QUnit.assert.strictEqual(Csv.file_name('bench_raw', ''),
                'bench_raw.csv', 'a campaign with no run id still names its' +
                ' file');
            files.forEach(function(file) {
                QUnit.assert.ok(file.content.length > 0,
                    file.name + ' carries at least its header');
            });
        });

    QUnit.test('Benchmark Csv leaves the ungated percentile cells empty',
        function() {
            // Functional criterion 6 all the way through to the file: on a
            // 100 iteration campaign p50, p75 and p90 are filled while p95
            // and p99 are empty cells.
            var samples = [];
            for (var i = 1; i <= 100; i++) {
                samples.push({
                    kind: 'phase', scenario: 'Contract', phase: 'search',
                    regime: 'cold', arm: 'direct', warmup: false,
                    served_from_cache: false, causes: [], duration_ms: i
                });
            }
            var csv = Csv.build_agg({run_id: 'R1', meta: {}, samples: samples},
                {delimiter: ',', bom: false}).split('\r\n');
            var header = csv[0].split(',');
            var row = csv[1].split(',');
            var cell = function(name) {
                return row[header.indexOf(name)];
            };
            QUnit.assert.strictEqual(cell('n'), '100', 'a hundred samples');
            QUnit.assert.strictEqual(cell('p50_ms'), '50.000', 'p50 is filled');
            QUnit.assert.strictEqual(cell('p75_ms'), '75.000', 'p75 is filled');
            QUnit.assert.strictEqual(cell('p90_ms'), '90.000', 'p90 is filled');
            QUnit.assert.strictEqual(cell('p95_ms'), '',
                'p95 is an empty cell at n = 100');
            QUnit.assert.strictEqual(cell('p99_ms'), '',
                'p99 is an empty cell at n = 100');
            QUnit.assert.strictEqual(cell('max_ms'), '100.000',
                'and the maximum is the true maximum');
        });

    QUnit.test('Benchmark Probe refuses an entry to a call still in flight',
        function() {
            // THE defect, reproduced.  Two calls on the same method: A starts
            // at 0 and is slow, B starts 15 ms later and is quick, so B's
            // entry is delivered while A is still in flight.
            var a = attempt('model.party.party.search_count', 0);
            var b = attempt('model.party.party.search_count', 15, 38);
            var b_entry = entry('model.party.party.search_count', 15, 20);
            // What the old code did.  A being in flight, its upper bound was
            // now(): its window brackets by construction every call emitted
            // after it, so the head of the queue took the entry -- silently,
            // because a rejection was the only thing that raised a cause.
            QUnit.assert.ok(containment_accepts(b_entry, a, 100),
                'the containment test accepts the WRONG call: that is the' +
                ' defect it is being replaced for');
            QUnit.assert.strictEqual(Probe.resource_entry_fits(b_entry, a),
                false, 'an entry that started 15 ms after the ajaxSend of a' +
                ' call does not belong to that call');
            var match = Probe.match_resource_entry(b_entry, [a, b]);
            QUnit.assert.strictEqual(match.verdict, 'matched',
                'exactly one candidate can own it');
            QUnit.assert.strictEqual(match.attempt, b,
                'and it is the call that actually started then');
            // The entry of the slow call arrives next, with B consumed.
            var a_entry = entry('model.party.party.search_count', 0, 80);
            var second = Probe.match_resource_entry(a_entry, [a]);
            QUnit.assert.strictEqual(second.attempt, a,
                'and the slow call then gets its own decomposition');
        });

    QUnit.test('Benchmark Probe records an ambiguity instead of guessing',
        function() {
            // Sao.View.Form.Link.set_state (form.js:1194-1226) emits one
            // search_count per tab domain in a single synchronous pass: the
            // calls are microseconds apart on the same method, and
            // performance.now() is clamped to ~100 us.  Nothing can tell them
            // apart, so nothing may be attributed.
            var first = attempt('model.party.party.search_count', 0.1);
            var second = attempt('model.party.party.search_count', 0.3);
            var third = attempt('model.party.party.search_count', 0.4);
            var one = entry('model.party.party.search_count', 0.3, 40);
            var match = Probe.match_resource_entry(one,
                [first, second, third]);
            QUnit.assert.strictEqual(match.verdict, 'ambiguous',
                'three candidates within tolerance is not a match');
            QUnit.assert.strictEqual(match.attempt, null,
                'no attempt is picked');
            QUnit.assert.strictEqual(match.eligible.length, 3,
                'and all three are reported, so all three can be excluded');
            QUnit.assert.ok(
                Probe.INVALIDATING_CAUSES.indexOf(
                    'resource_timing_ambiguous') >= 0,
                'the ambiguity cause invalidates the sample');
            QUnit.assert.strictEqual(
                Probe.is_valid({causes: ['resource_timing_ambiguous']}), false,
                'a sample carrying it is not valid');
        });

    QUnit.test('Benchmark Probe separates concurrent calls by method',
        function() {
            // The url fragment survives into entry.name even though it is
            // never transmitted: rpc.js:188 writes the method there and the
            // entry is named after the url the fetch was created with.  Two
            // calls fired in the same pass on DIFFERENT methods are therefore
            // decidable, and must not be sacrificed to the ambiguity rule.
            var search = attempt('model.party.party.search', 0.1);
            var count = attempt('model.party.party.search_count', 0.2);
            var match = Probe.match_resource_entry(
                entry('model.party.party.search_count', 0.2, 30),
                [search, count]);
            QUnit.assert.strictEqual(match.verdict, 'matched',
                'the method tells them apart');
            QUnit.assert.strictEqual(match.attempt, count,
                'and it is the right one');
        });

    QUnit.test('Benchmark Probe falls back on timing without a fragment',
        function() {
            // A browser that strips the fragment from entry.name must lose
            // the extra key, never gain a wrong exclusion.
            var bare = entry('', 0.2, 30);
            var count = attempt('model.party.party.search_count', 0.2);
            QUnit.assert.strictEqual(Probe.resource_entry_fits(bare, count),
                true, 'an entry with no method is decided on timing alone');
            var alone = Probe.match_resource_entry(bare, [count]);
            QUnit.assert.strictEqual(alone.attempt, count,
                'so a serial call still gets its decomposition');
            var other = attempt('model.party.party.search', 0.1);
            QUnit.assert.strictEqual(
                Probe.match_resource_entry(bare, [other, count]).verdict,
                'ambiguous',
                'and two concurrent calls become undecidable, as they should');
        });

    QUnit.test('Benchmark Probe leaves a serialized queue exact', function() {
            // A list scenario runs one call at a time.  The queue can still
            // hold the NEXT attempt when a late entry is delivered, and that
            // must not turn an exact match into an ambiguity: the yield of
            // the list scenarios is 100% and has to stay there.
            var first = attempt('model.party.party.search', 0, 30);
            var second = attempt('model.party.party.search', 34);
            var match = Probe.match_resource_entry(
                entry('model.party.party.search', 0.2, 29), [first, second]);
            QUnit.assert.strictEqual(match.verdict, 'matched',
                'the entry of the first call is not disputed by the second');
            QUnit.assert.strictEqual(match.attempt, first, 'and it is exact');
        });

    QUnit.test('Benchmark Probe rejects an entry that outlived the call',
        function() {
            // ajaxComplete fires once the whole response is in, so an entry
            // still downloading after that instant belongs to another call.
            var call = attempt('model.party.party.read', 0, 30);
            QUnit.assert.strictEqual(
                Probe.resource_entry_fits(
                    entry('model.party.party.read', 0.2, 25), call),
                true, 'a response that landed before ajaxComplete fits');
            QUnit.assert.strictEqual(
                Probe.resource_entry_fits(
                    entry('model.party.party.read', 0.2, 90), call),
                false, 'one that was still arriving afterwards does not');
            QUnit.assert.strictEqual(
                Probe.match_resource_entry(
                    entry('model.party.party.read', 0.2, 90),
                    [call]).verdict,
                'orphan', 'and with no other candidate it is an orphan');
        });

    QUnit.test('Benchmark Probe expires attempts that will get no entry',
        function() {
            var done = attempt('model.party.party.read', 0, 30);
            var flying = attempt('model.party.party.read', 0);
            QUnit.assert.strictEqual(
                Probe.resource_entry_expired(done, 1000), false,
                'a call that ended a moment ago still waits for its entry');
            QUnit.assert.strictEqual(
                Probe.resource_entry_expired(done, 60000), true,
                'one whose response landed a minute ago never will');
            QUnit.assert.strictEqual(
                Probe.resource_entry_expired(flying, 60000), false,
                'a call still in flight never expires');
        });

    QUnit.test('Benchmark Csv counts an ambiguity under n_invalid',
        function() {
            // The ambiguity has to reach the operator: a cause tallied in
            // bench_agg.csv, and a value that never contributes.
            var rows = Csv.aggregate({
                run_id: 'R1',
                meta: {},
                samples: [{
                    kind: 'rpc', scenario: 'Company', regime: 'warm',
                    arm: 'direct', warmup: false, served_from_cache: false,
                    rpc_method: 'model.party.party.search_count',
                    seq: 0, duration_ms: 11, causes: []
                }, {
                    kind: 'rpc', scenario: 'Company', regime: 'warm',
                    arm: 'direct', warmup: false, served_from_cache: false,
                    rpc_method: 'model.party.party.search_count',
                    seq: 1, duration_ms: 999,
                    causes: ['resource_timing_ambiguous']
                }]
            });
            QUnit.assert.strictEqual(rows.length, 1, 'one group');
            QUnit.assert.strictEqual(rows[0].n, 1,
                'the ambiguous sample contributes no value');
            QUnit.assert.strictEqual(rows[0].n_invalid, 1,
                'it is counted as invalid');
            QUnit.assert.strictEqual(rows[0].invalid_causes,
                'resource_timing_ambiguous=1',
                'and the reason is named, not merely counted');
            QUnit.assert.strictEqual(rows[0].max, 11,
                'the discarded 999 never reaches the aggregate');
        });

    QUnit.test('Benchmark Csv meta reports the ambiguous entry count',
        function() {
            var header = Csv.build_meta(
                {meta: {}}, {delimiter: ',', bom: false}).split('\r\n')[0]
                .split(',');
            ['orphan_resource_entries', 'ambiguous_resource_entries',
                'resource_timing_desync', 'resource_entry_count',
                'rpc_ajax_send_count'].forEach(function(name) {
                    QUnit.assert.ok(header.indexOf(name) >= 0,
                        'bench_meta.csv carries the ' + name + ' column');
                });
        });

}());
