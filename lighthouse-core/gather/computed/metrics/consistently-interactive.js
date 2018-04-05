/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

const MetricArtifact = require('./metric');

const NetworkRecorder = require('../../../lib/network-recorder');
const TracingProcessor = require('../../../lib/traces/tracing-processor');
const LHError = require('../../../lib/errors');

const REQUIRED_QUIET_WINDOW = 5000;
const ALLOWED_CONCURRENT_REQUESTS = 2;

class ConsistentlyInteractive extends MetricArtifact {
  get name() {
    return 'ConsistentlyInteractive';
  }

  /**
   * Finds all time periods where the number of inflight requests is less than or equal to the
   * number of allowed concurrent requests (2).
   * @param {Array<LH.WebInspector.NetworkRequest>} networkRecords
   * @param {{timestamps: {traceEnd: number}}} traceOfTab
   * @return {!Array<!TimePeriod>}
   */
  static _findNetworkQuietPeriods(networkRecords, traceOfTab) {
    const traceEndTsInMs = traceOfTab.timestamps.traceEnd / 1000;
    return NetworkRecorder.findNetworkQuietPeriods(networkRecords,
      ALLOWED_CONCURRENT_REQUESTS, traceEndTsInMs);
  }

  /**
   * Finds all time periods where there are no long tasks.
   * @param {!Array<!TimePeriod>} longTasks
   * @param {{timestamps: {navigationStart: number, traceEnd: number}}} traceOfTab
   * @return {!Array<!TimePeriod>}
   */
  static _findCPUQuietPeriods(longTasks, traceOfTab) {
    const navStartTsInMs = traceOfTab.timestamps.navigationStart / 1000;
    const traceEndTsInMs = traceOfTab.timestamps.traceEnd / 1000;
    if (longTasks.length === 0) {
      return [{start: 0, end: traceEndTsInMs}];
    }

    const quietPeriods = [];
    longTasks.forEach((task, index) => {
      if (index === 0) {
        quietPeriods.push({
          start: 0,
          end: task.start + navStartTsInMs,
        });
      }

      if (index === longTasks.length - 1) {
        quietPeriods.push({
          start: task.end + navStartTsInMs,
          end: traceEndTsInMs,
        });
      } else {
        quietPeriods.push({
          start: task.end + navStartTsInMs,
          end: longTasks[index + 1].start + navStartTsInMs,
        });
      }
    });

    return quietPeriods;
  }

  /**
   * Finds the first time period where a network quiet period and a CPU quiet period overlap.
   * @param {!Array<!TimePeriod>} longTasks
   * @param {Array<LH.WebInspector.NetworkRequest>} networkRecords
   * @param {{timestamps: {navigationStart: number, firstMeaningfulPaint: number,
   *    traceEnd: number}}} traceOfTab
   * @return {{cpuQuietPeriod: !TimePeriod, networkQuietPeriod: !TimePeriod,
   *    cpuQuietPeriods: !Array<!TimePeriod>, networkQuietPeriods: !Array<!TimePeriod>}}
   */
  static findOverlappingQuietPeriods(longTasks, networkRecords, traceOfTab) {
    const FMPTsInMs = traceOfTab.timestamps.firstMeaningfulPaint / 1000;

    const isLongEnoughQuietPeriod = period =>
        period.end > FMPTsInMs + REQUIRED_QUIET_WINDOW &&
        period.end - period.start >= REQUIRED_QUIET_WINDOW;
    const networkQuietPeriods = this._findNetworkQuietPeriods(networkRecords, traceOfTab)
        .filter(isLongEnoughQuietPeriod);
    const cpuQuietPeriods = this._findCPUQuietPeriods(longTasks, traceOfTab)
        .filter(isLongEnoughQuietPeriod);

    const cpuQueue = cpuQuietPeriods.slice();
    const networkQueue = networkQuietPeriods.slice();

    // We will check for a CPU quiet period contained within a Network quiet period or vice-versa
    let cpuCandidate = cpuQueue.shift();
    let networkCandidate = networkQueue.shift();
    while (cpuCandidate && networkCandidate) {
      if (cpuCandidate.start >= networkCandidate.start) {
        // CPU starts later than network, window must be contained by network or we check the next
        if (networkCandidate.end >= cpuCandidate.start + REQUIRED_QUIET_WINDOW) {
          return {
            cpuQuietPeriod: cpuCandidate,
            networkQuietPeriod: networkCandidate,
            cpuQuietPeriods,
            networkQuietPeriods,
          };
        } else {
          networkCandidate = networkQueue.shift();
        }
      } else {
        // Network starts later than CPU, window must be contained by CPU or we check the next
        if (cpuCandidate.end >= networkCandidate.start + REQUIRED_QUIET_WINDOW) {
          return {
            cpuQuietPeriod: cpuCandidate,
            networkQuietPeriod: networkCandidate,
            cpuQuietPeriods,
            networkQuietPeriods,
          };
        } else {
          cpuCandidate = cpuQueue.shift();
        }
      }
    }

    throw new LHError(
      cpuCandidate
        ? LHError.errors.NO_TTI_NETWORK_IDLE_PERIOD
        : LHError.errors.NO_TTI_CPU_IDLE_PERIOD
    );
  }

  /**
   * @param {LH.Gatherer.Artifact.MetricComputationData} data
   * @param {Object} artifacts
   * @return {Promise<LH.Gatherer.Artifact.Metric>}
   */
  computeObservedMetric(data, artifacts) {
    const {traceOfTab, networkRecords} = data;

    if (!traceOfTab.timestamps.firstMeaningfulPaint) {
      throw new LHError(LHError.errors.NO_FMP);
    }

    if (!traceOfTab.timestamps.domContentLoaded) {
      throw new LHError(LHError.errors.NO_DCL);
    }

    const longTasks = TracingProcessor.getMainThreadTopLevelEvents(traceOfTab)
        .filter(event => event.duration >= 50);
    const quietPeriodInfo = ConsistentlyInteractive.findOverlappingQuietPeriods(longTasks, networkRecords,
        traceOfTab);
    const cpuQuietPeriod = quietPeriodInfo.cpuQuietPeriod;

    const timestamp = Math.max(
      cpuQuietPeriod.start,
      traceOfTab.timestamps.firstMeaningfulPaint / 1000,
      traceOfTab.timestamps.domContentLoaded / 1000
    ) * 1000;
    const timing = (timestamp - traceOfTab.timestamps.navigationStart) / 1000;
    return {timing, timestamp};
  }
}

module.exports = ConsistentlyInteractive;

/**
 * @typedef TimePeriod
 * @property {number} start
 * @property {number} end
 */
