/**
 * Copyright 2018 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as util from './util.mjs';
import * as shared from './shared.mjs';
import {renderPosts, container} from './render.mjs';
import * as dbHelper from './firebaseHelper.mjs';

dbHelper.setApp(firebase.initializeApp(shared.firebaseConfig));

let _posts = [];
let _filteringBy = null;
const _includeTweets = true;//localStorage.getItem('includeTweets') === 'true';
const FILTERING_PARAMS = ['domain', 'author'];

const includeTweetsCheckbox = document.querySelector('#toggletweets');

async function fetchPosts(url, maxResults = null) {
  try {
    url = new URL(url, document.baseURI);
    if (maxResults) {
      url.searchParams.set('maxresults', maxResults);
    }
    const resp = await fetch(url.toString());
    const json = await resp.json();
    if (!resp.ok || json.error) {
      throw Error(json.error);
    }
    return json;
  } catch (err) {
    throw err;
  }
}

function handleDelete(el, dateStr, url) {
  const date = new Date(dateStr);
  dateStr = date.toJSON();
  const [year, month, day] = dateStr.split('-');

  if (!confirm('Are you sure you want to delete this post?')) {
    return false;
  }

  dbHelper.deletePost(year, month, url); // async

  return false;
}

function isTweet(post) {
  const twitterDomain = new URL(post.url).host.match('twitter.com');
  return post.submitter.bot && twitterDomain;
}

function filterBy(key, needle = null) {
  if (key && !FILTERING_PARAMS.includes(key)) {
    return;
  }

  const currentURL = new URL(location.href);
  const params = currentURL.searchParams;
  const filterEl = document.querySelector('#filtering');
  const needleEl = filterEl.querySelector('.filtering-needle');

  filterEl.hidden = false;

  // Clear all previous filters.
  for (const key of params.keys()) {
    if (FILTERING_PARAMS.includes(key)) {
      params.delete(key);
    }
  }

  let filteredPosts = _includeTweets ? _posts : _posts.filter(p => !isTweet(p));

  // TODO: support filtering on more than one thing.
  if (needle === _filteringBy) {
    params.delete(key);
    _filteringBy = null;
  } else {
    filteredPosts = filteredPosts.filter(post => post[key] === needle);
    params.set(key, needle);
    needleEl.textContent = needle;
    _filteringBy = needle;
  }

  includeTweetsCheckbox.disabled = _filteringBy;

  setTimeout(() => filterEl.classList.toggle('on', _filteringBy !== null), 0);

  window.history.pushState(null, '', currentURL.href);
  renderPosts(filteredPosts, container);
}

function clearFilters() {
  _filteringBy = null
  filterBy(null, null);
  return false;
}

/**
 * @param {string} year Year to monitor updates for.
 */
function realtimeUpdatePosts(year) {
  const originalTitle = document.title;
  let numChanges = 0;

  // Subscribe to real-time db updates for current year.
  // TODO: setup monitoring changes for previous years. e.g. refresh UI if a
 //  previous year's post is deleted.
  dbHelper.monitorRealtimeUpdateToPosts(year, async changes => {
    if (document.hidden) {
      document.title = `(${++numChanges}) ${originalTitle}`;
    }

    const month = changes[0].oldIndex; // Index in doc's maps to the the month.

    _posts = _posts.filter(post => {
      const s = new Date(post.submitted);
      const inMonthAndYear = String(s.getFullYear()) === year && s.getMonth() === month;
      return !inMonthAndYear || (inMonthAndYear && post.submitter.bot);
    });

    // for (const change of changes) {
    //   const items = change.doc.data().items;
    // }
    const updatePosts = changes[0].doc.data().items;

    _posts = util.uniquePosts([...updatePosts, ..._posts]); // update cache.

    // TODO: only render deltas. Currently rendering the entire list.
    renderPosts(_posts, container);
  });

  // Show additions as they come in the tab title.
  document.addEventListener('visibilitychange', e => {
    if (!document.hidden && numChanges) {
      document.title = originalTitle;
      numChanges = 0;
    }
  });
}

function toggleHelp() {
  function handleOverlayClick(e) {
    const helpContent = document.querySelector('.help-content');
    if (!helpContent.contains(e.target)) {
      toggleHelp();
      help.removeEventListener('click', handleOverlayClick);
    }
  }

  function handleKeyDown(e) {
    if (e.keyCode === 27) {
      toggleHelp();
      document.body.removeEventListener('keyup', handleKeyDown);
    }
  }

  const help = document.querySelector('#help');
  help.classList.toggle('active');

  if (help.classList.contains('active')) {
    document.body.style.overflow = 'hidden';
    help.addEventListener('click', handleOverlayClick);
    document.body.addEventListener('keyup', handleKeyDown);
  } else {
    document.body.style.overflow = '';
    help.removeEventListener('click', handleOverlayClick);
    document.body.removeEventListener('keyup', handleKeyDown);
  }
  return false;
}

// includeTweetsCheckbox.checked = _includeTweets;
// includeTweetsCheckbox.addEventListener('change', e => {
//   _includeTweets = e.target.checked;
//   localStorage.setItem('includeTweets', _includeTweets);
//   const posts = _includeTweets ? _posts : _posts.filter(p => !isTweet(p));
//   renderPosts(posts, container);
// });

async function getLatestPosts() {
  const lastYearsPosts = await fetchPosts(`/posts/${util.currentYear - 1}`);
  const thisYearsPosts = await fetchPosts(`/posts/${util.currentYear}`);
  const tweets = await fetchPosts(`/tweets/ChromiumDev`);

  // Ensure list of rendered posts is unique based on URL.
  // Note: it already comes back sorted so we never need to sort client-side.
  const posts = util.uniquePosts([...thisYearsPosts, ...lastYearsPosts, ...tweets]);

  return posts;
}

(async() => {
  const PRE_RENDERED = container.querySelector('#posts'); // Already exists in DOM if we've SSR.

  const params = new URL(location.href).searchParams;

  try {
    // Populates client-side cache for future realtime updates.
    // Note: this basically results in 2x requests per page load, as we're
    // making the same requests the server just made. Now repeating them client-side.
    _posts = await getLatestPosts();

    let posts = _posts;
    // if (!_includeTweets) {
    //   posts = _posts.filter(p => !isTweet(p));
    // }

     // Posts markup is already in place if we're SSRing. Don't re-render DOM.
    if (!PRE_RENDERED) {
      renderPosts(posts, container);
    }

    realtimeUpdatePosts(util.currentYear);  // Subscribe to realtime firestore updates.

    if (params.has('edit')) {
      container.classList.add('edit');
    } else {
      for (const key of params.keys()) {
        filterBy(key, params.get(key));
      }
    }
  } catch (err) {
    console.error(err);
  }
})();

window.handleDelete = handleDelete;
window.filterBy = filterBy;
window.clearFilters = clearFilters;
window.toggleHelp = toggleHelp;
