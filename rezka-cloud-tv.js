/* Experimental TV repair. Startup and request mocks tested; Samsung and live login unverified. Based on ABurnglv/lampa-hdrezka-plugin. */
/*!
 * HDREZKA plugin for Lampa
 * --------------------------------------------------------
 *  - Online-balanser source (button "HDREZKA" on the card)
 *  - Account login (login + password) via /ajax/login/
 *  - Configurable mirror domain (default: rezka.fi)
 *  - Settings panel: domain / login / password / login button / status
 *
 *  Tested against the public HDREZKA site engine (DLE-based).
 *  Author: generated for the user via Perplexity Computer.
 *  License: MIT
 */
(function () {
    'use strict';

    if (window.rezka_plugin_ready) return;
    window.rezka_plugin_ready = true; // Disable other copies before loading this file.

    /* ====================================================
     *  Plugin manifest (shown in Lampa "Extensions" panel)
     * ==================================================== */
    var manifest = {
        type: 'video',
        version: '1.0.4-cloud',
        name: 'HDREZKA',
        description: 'Просмотр фильмов и сериалов с HDREZKA по личному аккаунту',
        component: 'rezka_online'
    };

    /* ====================================================
     *  Storage keys / defaults
     * ==================================================== */
    var STORAGE = {
        domain:   'rezka_domain',
        login:    'rezka_login',
        password: 'rezka_password',
        cookie:   'rezka_cookie',     // dle_user_id=...; dle_password=...
        status:   'rezka_status',     // 'logged' | 'guest' | 'error:<msg>'
        token:    'rezka_cloud_token',
        proxy:    'rezka_proxy_url'   // optional CORS proxy
    };

    /* Безопасный вызов Lampa.Storage.add — в разных билдах Lampa
       сигнатура разная. Используем get(name, default) — это работает везде.
       Сразу и инициализируем по умолчаниям через set(…, default), если пусто. */
    function ensureDefaults() {
        var defaults = {};
        defaults[STORAGE.domain]   = 'https://rezka.fi';
        defaults[STORAGE.login]    = '';
        defaults[STORAGE.password] = '';
        defaults[STORAGE.cookie]   = '';
        defaults[STORAGE.status]   = 'guest';
        defaults[STORAGE.proxy]    = '';
        defaults[STORAGE.token] = '';
        Object.keys(defaults).forEach(function (k) {
            try {
                var cur = Lampa.Storage.get(k, '__none__');
                if (cur === '__none__' || cur === null || cur === undefined) {
                    Lampa.Storage.set(k, defaults[k]);
                }
            } catch (err) {}
        });
    }

    /* ====================================================
     *  Helpers
     * ==================================================== */
    function getDomain() {
        var d = (Lampa.Storage.get(STORAGE.domain) || 'https://rezka.fi').trim();
        if (!/^https?:\/\//i.test(d)) d = 'https://' + d;
        return d.replace(/\/+$/, '');
    }

    function getCookie() {
        return (Lampa.Storage.get(STORAGE.cookie) || '').trim();
    }

    function isLoggedIn() {
        return Lampa.Storage.get(STORAGE.status) === 'logged';
    }

    function buildHeaders(extra) {
        // Cookies belong to the target origin and are handled by the browser.
        var headers = { 'Accept': '*/*' };
        if (extra) for (var k in extra) {
            if (Object.prototype.hasOwnProperty.call(extra, k) &&
                !/^(cookie|referer|user-agent|x-requested-with)$/i.test(k)) headers[k] = extra[k];
        }
        return headers;
    }

    function networkError(a) {
        if (a && a.cloudMessage) return a.cloudMessage;
        if (a && a.status) return 'HTTP ' + a.status;
        return 'Нет ответа: сеть, TLS или CORS. HTTP 200 плагина не проверяет HDRezka.';
    }

    /**
     * Pass URL through optional CORS proxy if user configured one.
     */
    function proxify(url) { return url; }

    function saveCloudCookies(lines) {
        var values = Object.create(null);
        getCookie().split(';').forEach(function (part) {
            var pos = part.indexOf('=');
            if (pos > 0) values[part.slice(0, pos).trim()] = part.slice(pos + 1).trim();
        });
        (lines || []).forEach(function (line) {
            var pair = line.split(';')[0], pos = pair.indexOf('=');
            if (pos <= 0) return;
            var name = pair.slice(0, pos).trim(), value = pair.slice(pos + 1);
            if (value === 'deleted' || /max-age=0(?:;|$)/i.test(line)) delete values[name];
            else values[name] = value;
        });
        Lampa.Storage.set(STORAGE.cookie, Object.keys(values).map(function (name) {
            return name + '=' + values[name];
        }).join('; '));
    }

    /**
     * HDREZKA "trash list" decoder for video URL (#h<base64-with-trash> payload).
     * 1:1 with the canonical algorithm used in nb557/online_mod and HdRezkaApi.
     */
    function decodeTrash(data) {
        if (!data || typeof data !== 'string') return data;
        if (data.charAt(0) !== '#') return data;

        // Сервер вставляет base64-версии этих строк, предварённых //_//
        var trashList = ['$$!!@$$@^!@#$$@', '@@@@@!##!^^^', '####^!!##!@@', '^^^!@##!!##', '$$#!!@#!@##'];

        // Аналог браузерного btoa() для UTF-8 строк
        function enc(str) {
            return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g,
                function (m, p1) { return String.fromCharCode(parseInt(p1, 16)); }));
        }
        function dec(str) {
            return decodeURIComponent(atob(str).split('').map(function (c) {
                return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
            }).join(''));
        }
        function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

        var x = data.substring(2); // убираем ведущие два символа (обычно "#h")
        trashList.forEach(function (t) {
            var token = '//_//' + enc(t);
            // все вхождения, а не только первое
            x = x.split(token).join('');
        });
        try { return dec(x); } catch (e) {
            try { return atob(x); } catch (e2) { return ''; }
        }
    }

    /**
     * Parse the HDREZKA playlist string returned by /ajax/get_cdn_series/.
     * Format (after decode): [1080p Ultra]https://x/1080.mp4 or https://x/1080.mp4,[720p]...
     */
    function parsePlaylist(str) {
        if (!str) return [];
        var result = [];
        var parts = str.split(',');
        parts.forEach(function (part) {
            var m = part.match(/\[([^\]]+)\](.+)/);
            if (!m) return;
            var label = m[1].trim();
            var urls = m[2].split(' or ');
            // last URL is usually the highest-quality / mp4 fallback
            var file = urls[urls.length - 1].trim();
            result.push({ label: label, file: file });
        });
        return result;
    }

    /**
     * Network helper – wraps Lampa.Reguest / native fetch.
     */
    function request(opts, success, error) {
        var token = (Lampa.Storage.get(STORAGE.token) || '').trim();
        if (!token) { error({status: 0, cloudMessage: 'Введите ключ облачного прокси'}); return; }
        var path = opts.url;
        if (/^https?:\/\//i.test(path)) {
            if (path.indexOf('https://rezka.fi/') !== 0) {
                error({cloudMessage: 'Облачный прокси настроен только для https://rezka.fi'}); return;
            }
            path = path.substring('https://rezka.fi'.length);
        }
        var xhr = new XMLHttpRequest();
        xhr.open('POST', 'https://rezka-private.defcon686.workers.dev/request', true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.setRequestHeader('X-Proxy-Token', token);
        xhr.withCredentials = false;
        xhr.timeout = 20000;
        xhr.onload = function () {
            var envelope;
            try { envelope = JSON.parse(xhr.responseText); }
            catch (e) { error({status: xhr.status, cloudMessage: 'Прокси вернул неверный ответ'}); return; }
            if (xhr.status !== 200 || envelope.error) {
                error({status: xhr.status, cloudMessage: envelope.error === 'unauthorized' ? 'Неверный ключ прокси' : envelope.error}); return;
            }
            if (envelope.redirected || envelope.upstreamStatus < 200 || envelope.upstreamStatus >= 300) {
                error({status: envelope.upstreamStatus}); return;
            }
            saveCloudCookies(envelope.setCookie);
            var result = envelope.body;
            if (opts.dataType === 'json') {
                try { result = JSON.parse(result); }
                catch (e) { error({cloudMessage: 'HDRezka вернул страницу вместо JSON'}); return; }
            }
            success(result);
        };
        xhr.onerror = function () { error({status: 0}); };
        xhr.ontimeout = function () { error({cloudMessage: 'Прокси не ответил вовремя'}); };
        xhr.send(JSON.stringify({path: path, method: opts.post ? 'POST' : 'GET',
            body: opts.post || '', cookie: getCookie()}));
        return xhr;
    }

    /* ====================================================
     *  Auth: login to HDREZKA
     * ==================================================== */
    function authenticate(login, password, cb) {
        Lampa.Storage.set(STORAGE.status, 'guest');
        Lampa.Storage.set(STORAGE.cookie, '');
        request({url: getDomain() + '/ajax/login/?t=' + Date.now(),
            post: 'login_name=' + encodeURIComponent(login) +
                  '&login_password=' + encodeURIComponent(password) + '&login_not_save=0',
            headers: {'Content-Type': 'application/x-www-form-urlencoded'}}, function (resp) {
            var json;
            try { json = typeof resp === 'object' ? resp : JSON.parse(resp); }
            catch (e) { cb(false, 'Ответ не JSON: возможна страница защиты или неверный домен.'); return; }
            if (json && json.success === true && getCookie()) {
                Lampa.Storage.set(STORAGE.status, 'logged');
                cb(true, 'Вход принят, сессия сохранена на телевизоре.');
            } else {
                Lampa.Storage.set(STORAGE.status, 'error:login');
                cb(false, json && json.message || 'Сервер отклонил вход');
            }
        }, function (a) {
            Lampa.Storage.set(STORAGE.status, 'error:network');
            cb(false, networkError(a));
        });
    }
    function logout() {
        Lampa.Storage.set(STORAGE.cookie, '');
        Lampa.Storage.set(STORAGE.status, 'guest');
    }

    /* ====================================================
     *  Search on HDREZKA
     *  GET /engine/ajax/search.php?q=<title>
     * ==================================================== */
    function searchRezka(query, year, cb, err) {
        var url = proxify(getDomain() + '/engine/ajax/search.php?q=' + encodeURIComponent(query));
        request({ url: url }, function (html) {
            // <li><a href="..."><span class="enty">Title</span> (Original, 2023)<span class="rating">8.50</span></a></li>
            var div = document.createElement('div');
            div.innerHTML = html;
            var items = [];
            Array.prototype.forEach.call(div.querySelectorAll('a'), function (a) {
                var href = a.getAttribute('href');
                if (!href || href.indexOf('search') !== -1) return;
                // Основное название — из .enty (русский вариант)
                var entyEl = a.querySelector('.enty');
                var title = entyEl ? (entyEl.textContent || '').trim() : '';
                // Полный текст (содержит и оригинал, и год, и рейтинг)
                var fullText = (a.textContent || '').trim();
                if (!title) {
                    // без .enty — берём всю строку до «(слово, год)»
                    title = fullText.replace(/\s*\([^)]*\d{4}\)[\s\S]*$/, '').trim();
                }
                // Год — из любого вхождения (4 цифры 19xx/20xx)
                var ym = fullText.match(/\b(19|20)\d{2}\b/);
                items.push({
                    url: href,
                    title: title,
                    year: ym ? ym[0] : ''
                });
            });
            // если знаем год — предпочитаем точное совпадение
            if (year) {
                var exact = items.filter(function (i) { return i.year == String(year); });
                if (exact.length) items = exact;
            }
            cb(items);
        }, function (error) { if (err) err('Поиск: ' + networkError(error)); else cb([]); });
    }

    /* ====================================================
     *  Parse film page → translators / seasons / film_id
     * ==================================================== */
    function fetchFilmPage(filmUrl, cb, err) {
        request({ url: proxify(filmUrl), dataType: 'text' }, function (str) {
            var info = {
                film_id: '',
                is_series: false,
                favs: '',
                voice: [],   // [{name, id, is_camrip, is_ads, is_director}]
                season: [],  // [{name, id}]
                episode: [], // [{name, season_id, episode_id}]
                page_url: filmUrl
            };

            // film id
            var idm = str.match(/initCDN(?:Series|Movies)Events\(\s*(\d+)\s*,\s*(\d+)\s*,\s*([01])\s*,\s*([01])\s*(?:,\s*([01]))?/);
            if (idm) {
                info.film_id = idm[1];
                var defVoiceId = idm[2];
                info.is_series = /initCDNSeriesEvents/.test(str);
                var camrip = idm[3], ads = idm[4], director = idm[5] || '0';

                // favs hash
                var fm = str.match(/var\s+sof\s*=.*?\.send\([^,]+,\s*'([^']+)'/);
                if (!fm) fm = str.match(/data-favs="([^"]+)"/);
                if (fm) info.favs = fm[1];

                // translators block
                var tm = str.match(/<ul[^>]+class="b-translator__list"[\s\S]*?<\/ul>/);
                if (tm) {
                    var d = document.createElement('div');
                    d.innerHTML = tm[0];
                    Array.prototype.forEach.call(d.querySelectorAll('.b-translator__item'), function (li) {
                        info.voice.push({
                            name: (li.getAttribute('title') || li.textContent || '').trim(),
                            id: li.getAttribute('data-translator_id') || defVoiceId,
                            is_camrip:   li.getAttribute('data-camrip')   || camrip,
                            is_ads:      li.getAttribute('data-ads')      || ads,
                            is_director: li.getAttribute('data-director') || director
                        });
                    });
                }
                if (!info.voice.length) {
                    var defName = '';
                    var dn = str.match(/<h2>В переводе<\/h2>:[\s\S]*?<td[^>]*>(.*?)<\/td>/);
                    if (dn) {
                        var dd = document.createElement('div'); dd.innerHTML = dn[1];
                        defName = (dd.textContent || '').trim();
                    }
                    info.voice.push({
                        name: defName || 'Оригинал',
                        id: defVoiceId,
                        is_camrip: camrip, is_ads: ads, is_director: director
                    });
                }

                if (info.is_series) {
                    var sm = str.match(/<ul[^>]+class="b-simple_seasons__list"[\s\S]*?<\/ul>/);
                    if (sm) {
                        var ds = document.createElement('div'); ds.innerHTML = sm[0];
                        Array.prototype.forEach.call(ds.querySelectorAll('.b-simple_season__item'), function (li) {
                            info.season.push({
                                name: (li.textContent || '').trim(),
                                id: li.getAttribute('data-tab_id')
                            });
                        });
                    }
                    var em = str.match(/<ul[^>]+class="b-simple_episodes__list"[\s\S]*?<\/ul>/g);
                    if (em) {
                        em.forEach(function (block) {
                            var de = document.createElement('div'); de.innerHTML = block;
                            Array.prototype.forEach.call(de.querySelectorAll('.b-simple_episode__item'), function (li) {
                                info.episode.push({
                                    name: (li.textContent || '').trim(),
                                    season_id: li.getAttribute('data-season_id'),
                                    episode_id: li.getAttribute('data-episode_id')
                                });
                            });
                        });
                    }
                }
                cb(info);
            } else {
                err && err('Не удалось распарсить страницу');
            }
        }, function (error) { err && err('Страница фильма: ' + networkError(error)); });
    }

    /* ====================================================
     *  Get direct stream url
     *  POST /ajax/get_cdn_series/  (action=get_movie | get_stream)
     * ==================================================== */
    function getStream(info, voice, season, episode, cb, err) {
        var url = proxify(getDomain() + '/ajax/get_cdn_series/?t=' + Date.now());
        var post;
        if (info.is_series && season && episode) {
            post = 'id=' + encodeURIComponent(info.film_id) +
                   '&translator_id=' + encodeURIComponent(voice.id) +
                   '&season=' + encodeURIComponent(season.id) +
                   '&episode=' + encodeURIComponent(episode.episode_id) +
                   '&favs=' + encodeURIComponent(info.favs || '') +
                   '&action=get_stream';
        } else {
            post = 'id=' + encodeURIComponent(info.film_id) +
                   '&translator_id=' + encodeURIComponent(voice.id) +
                   '&is_camrip=' + encodeURIComponent(voice.is_camrip || 0) +
                   '&is_ads=' + encodeURIComponent(voice.is_ads || 0) +
                   '&is_director=' + encodeURIComponent(voice.is_director || 0) +
                   '&favs=' + encodeURIComponent(info.favs || '') +
                   '&action=get_movie';
        }

        request({url: url, post: post, dataType: 'json'}, function (json) {
            if (!json.success) { err && err(json.message || 'Сервер вернул ошибку'); return; }
            try {
                var items = parsePlaylist(decodeTrash(json.url));
                if (!items.length) { err && err('Пустой плейлист'); return; }
                var qualities = {};
                items.forEach(function (it) { qualities[it.label] = it.file; });
                cb({title: '', file: items[items.length - 1].file,
                    quality: qualities, subtitles: parseSubtitles(json.subtitle)});
            } catch (e) { err && err('Не удалось разобрать плейлист'); }
        }, function (a) { err && err(networkError(a)); });
    }

    function parseSubtitles(s) {
        if (!s || typeof s !== 'string') return [];
        // format: "[lang]url,[lang2]url2,..."
        return s.split(',').map(function (part) {
            var m = part.match(/\[([^\]]+)\](.+)/);
            return m ? { label: m[1], url: m[2] } : null;
        }).filter(Boolean);
    }

    /* ====================================================
     *  Lampa Online component
     * ==================================================== */
    function escapeHtml(value) {
        return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function component(object) {
        var network = new Lampa.Reguest();
        var scroll = new Lampa.Scroll({ mask: true, over: true });
        var files = new Lampa.Explorer(object);
        var filter = new Lampa.Filter(object);
        var html = $('<div></div>');

        var state = {
            info: null,
            choice: { voice: 0, season: 0 }
        };

        this.create = function () {
            scroll.minus();
            files.appendFiles(scroll.render());
            files.appendHead(filter.render());

            filter.onSearch = function (value) {
                Lampa.Activity.replace({ search: value, clarification: true });
            };
            filter.onBack = function () { self.start(); };

            return this.render();
        };

        this.render = function () { return files.render(); };

        var self = this;
        var initialized = false;

        this.start = function () {
            if (Lampa.Activity.active().activity !== this.activity) return;
            if (!initialized) { initialized = true; this.initialize(); }
            Lampa.Background.immediately(Lampa.Utils.cardImgBackgroundBlur(object.movie));
            Lampa.Controller.add('content', {
                toggle: function () {
                    Lampa.Controller.collectionSet(scroll.render(), files.render());
                    Lampa.Controller.collectionFocus(false, scroll.render());
                },
                up: function () {
                    if (Navigator.canmove('up')) Navigator.move('up');
                    else Lampa.Controller.toggle('head');
                },
                down: function () { Navigator.move('down'); },
                left: function () { Lampa.Controller.toggle('menu'); },
                right: function () { Navigator.move('right'); },
                back: this.back
            });
            Lampa.Controller.toggle('content');
        };

        this.pause = function () {};
        this.stop = function () {};
        this.back = function () { Lampa.Activity.backward(); };
        this.destroy = function () {
            network.clear();
            scroll.destroy();
            files.destroy();
            filter.destroy();
            html.remove();
        };

        // search & render flow ---------------------------------
        function showError(msg) {
            html.empty();
            var empty = new Lampa.Empty({ title: 'HDREZKA', descr: msg, text: msg });
            html.append(empty.render());
            scroll.append(html);
        }

        function buildList() {
            html.empty();
            if (!state.info) return;
            var info = state.info;

            var voice = info.voice[state.choice.voice] || info.voice[0];
            var season = info.season[state.choice.season];

            var items = [];
            if (info.is_series && season) {
                items = info.episode.filter(function (e) { return String(e.season_id) === String(season.id); });
            } else {
                items = [{ name: 'Смотреть фильм', episode_id: 0, season_id: 0, _movie: true }];
            }

            items.forEach(function (ep) {
                var item = $('<div class="online"><div class="online__title">' + escapeHtml(ep.name) +
                    '</div><div class="online__quality">' + escapeHtml(voice.name) + '</div></div>');
                item.on('hover:enter', function () {
                    Lampa.Modal.open({
                        title: 'HDREZKA',
                        html: $('<div style="padding:1em">Получаем ссылку…</div>'),
                        size: 'small',
                        onBack: function () { Lampa.Modal.close(); Lampa.Controller.toggle('content'); }
                    });
                    getStream(info, voice,
                        info.is_series ? season : null,
                        info.is_series ? ep : null,
                        function (data) {
                            Lampa.Modal.close();
                            Lampa.Player.play({
                                url: data.file,
                                title: object.movie.title || object.movie.name || '',
                                quality: data.quality,
                                subtitles: data.subtitles
                            });
                            Lampa.Player.playlist([{
                                url: data.file,
                                title: object.movie.title || object.movie.name || '',
                                quality: data.quality,
                                subtitles: data.subtitles
                            }]);
                        },
                        function (msg) {
                            Lampa.Modal.close();
                            Lampa.Noty.show('HDREZKA: ' + msg);
                        });
                });
                html.append(item);
            });
            scroll.append(html);
            Lampa.Controller.enable('content');
        }

        function buildFilter() {
            if (!state.info) return;
            var info = state.info;
            var f = {
                voice: info.voice.map(function (v) { return v.name; })
            };
            if (info.is_series) {
                f.season = info.season.map(function (s) { return s.name; });
            }
            filter.set('filter', Object.keys(f).map(function (key) {
                return { title: key === 'voice' ? 'Перевод' : 'Сезон', subtitle: f[key][state.choice[key]] || '—', stype: key };
            }));
            filter.onSelect = function (type, a, b) {
                if (a.stype) {
                    state.choice[a.stype] = b.index;
                    try { buildFilter(); buildList(); }
                    catch (error) { showError('Список фильма: ' + error.message); }
                }
            };
        }

        this.initialize = function () {
            this.activity.loader(true);

            var movie = object.movie || {};
            var title = object.search || movie.title || movie.name || '';
            var year = (movie.release_date || movie.first_air_date || '').slice(0, 4);

            searchRezka(title, year, function (results) {
                if (!results.length) {
                    self.activity.loader(false);
                    showError('Ничего не найдено на HDREZKA');
                    self.activity.toggle();
                    return;
                }
                fetchFilmPage(results[0].url, function (info) {
                    state.info = info;
                    self.activity.loader(false);
                    try { buildFilter(); buildList(); }
                    catch (error) { showError('Список фильма: ' + error.message); }
                    self.activity.toggle();
                }, function (msg) {
                    self.activity.loader(false);
                    showError(msg);
                    self.activity.toggle();
                });
            }, function (msg) {
                self.activity.loader(false);
                showError(msg);
                self.activity.toggle();
            });
        };
    }

    /* ====================================================
     *  Register component & online source button
     * ==================================================== */
    function registerComponent() {
        if (Lampa.Component && Lampa.Component.add) {
            Lampa.Component.add('rezka_online', component);
        }
    }

    function openRezka(movie) {
        Lampa.Activity.push({
            url: '',
            title: 'HDREZKA - ' + (movie.title || movie.name || ''),
            component: 'rezka_online',
            movie: movie,
            page: 1
        });
    }

    function addOnlineSource() {
        // Регистрация в Lampa.Online (источник в стандартной кнопке «Онлайн»)
        var source = {
            title: 'HDREZKA',
            search: function (movie, oncomplite) {
                openRezka(movie);
                oncomplite && oncomplite([]);
            },
            onContextMenu: function () { return { name: 'HDREZKA' }; }
        };
        if (Lampa.Online && Lampa.Online.register) {
            Lampa.Online.register('rezka', source);
        }
    }

    /* ====================================================
     *  Кнопка «HDREZKA» прямо в карточке фильма (рядом со «Смотреть»)
     *  Срабатывает на событии full → complite, когда карточка отрисована.
     * ==================================================== */
    function addCardButton() {
        // Inline-стили для кнопки (Lampa использует свои классы, мы
        // дополнительно добавляем минимальный CSS на случай отсутствия темы)
        var styleId = 'rezka-plugin-style';
        if (!document.getElementById(styleId)) {
            var st = document.createElement('style');
            st.id = styleId;
            st.innerHTML =
                '.full-start__button.view--rezka{background:linear-gradient(135deg,#1d8a3a,#0f5e25);color:#fff}' +
                '.full-start-new__buttons .view--rezka,.full-start__buttons .view--rezka{order:-1}' +
                '.view--rezka .button__icon{margin-right:.4em}';
            document.head.appendChild(st);
        }

        Lampa.Listener.follow('full', function (e) {
            if (e.type !== 'complite') return;

            var root = e.object.activity.render();
            // Поддерживаем разные темы карточки: новую и классическую
            var btnContainer = root.find('.full-start-new__buttons');
            if (!btnContainer.length) btnContainer = root.find('.full-start__buttons');
            if (!btnContainer.length) return;
            if (root.find('.view--rezka').length) return; // уже добавлена

            var label = '<svg class="button__icon" width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
                '<path d="M9 8l6 4-6 4V8z" fill="currentColor"/></svg>' +
                '<span>HDREZKA</span>';

            var btn = $(
                '<div class="full-start__button selector view--rezka">' + label + '</div>'
            );

            btn.on('hover:enter', function () { openRezka(e.data.movie); });

            // Помещаем кнопку ПЕРВОЙ — слева от «Смотреть» / «Онлайн»
            btnContainer.prepend(btn);

            // Делаем эту кнопку активной по умолчанию (фокус под указателем).
            // Lampa перестроит навигацию после prepend, поэтому нужно немного подождать.
            setTimeout(function () {
                try {
                    if (Navigator && Navigator.focused) {
                        Navigator.focused(btn[0]);
                    } else {
                        Lampa.Controller.collectionFocus(btn[0], root);
                    }
                } catch (err) {
                    // На некоторых сборках Navigator может быть недоступен
                    btn.addClass('focus');
                }
            }, 50);
        });
    }

    /* ====================================================
     *  Settings panel: domain / login / password / login
     * ==================================================== */
    function statusLabel() {
        var s = Lampa.Storage.get(STORAGE.status) || 'guest';
        if (s === 'logged') return '🟢 Вы вошли в аккаунт';
        if (s.indexOf('error:') === 0) return '🔴 Ошибка: ' + s.substring(6);
        return '⚪ Не авторизованы';
    }

    function addSettings() {
        Lampa.SettingsApi.addComponent({
            component: 'rezka',
            name: 'HDREZKA · Cloud 1.0.4',
            icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
                '<path d="M4 4h16v16H4z" stroke="currentColor" stroke-width="2"/>' +
                '<path d="M9 8l6 4-6 4V8z" fill="currentColor"/></svg>'
        });

        Lampa.SettingsApi.addParam({
            component: 'rezka',
            param: { name: STORAGE.domain, type: 'input', values: '', default: 'https://rezka.fi' },
            field: { name: 'Домен HDREZKA', description: 'Этот облачный прокси поддерживает только https://rezka.fi' },
            onChange: function () { Lampa.Storage.set(STORAGE.status, 'guest'); }
        });

        Lampa.SettingsApi.addParam({
            component: 'rezka',
            param: { name: STORAGE.login, type: 'input', values: '', default: '' },
            field: { name: 'Логин / E-mail', description: 'Email или имя пользователя HDREZKA' }
        });

        Lampa.SettingsApi.addParam({
            component: 'rezka',
            param: { name: STORAGE.password, type: 'input', values: '', default: '' },
            field: { name: 'Пароль', description: 'Хранится локально на устройстве' }
        });

        Lampa.SettingsApi.addParam({
            component: 'rezka',
            param: { name: 'rezka_login_button', type: 'trigger' },
            field: { name: 'Войти в аккаунт', description: statusLabel() },
            onChange: function () {
                var login = Lampa.Storage.get(STORAGE.login);
                var pwd   = Lampa.Storage.get(STORAGE.password);
                if (!login || !pwd) {
                    Lampa.Noty.show('Введите логин и пароль');
                    return;
                }
                Lampa.Noty.show('Авторизация на HDREZKA…');
                authenticate(login, pwd, function (ok, msg) {
                    Lampa.Noty.show((ok ? '✓ ' : '✗ ') + msg);
                    // refresh description
                    $('[data-name="rezka_login_button"] .settings-param__descr').text(statusLabel());
                });
            }
        });

        Lampa.SettingsApi.addParam({
            component: 'rezka',
            param: { name: 'rezka_logout_button', type: 'trigger' },
            field: { name: 'Выйти из аккаунта', description: 'Сбросить локальный статус входа; cookies сервера не удаляются' },
            onChange: function () {
                logout();
                Lampa.Noty.show('Сессия HDREZKA очищена');
                $('[data-name="rezka_login_button"] .settings-param__descr').text(statusLabel());
            }
        });

        Lampa.SettingsApi.addParam({
            component: 'rezka',
            param: { name: STORAGE.token, type: 'input', values: '', default: '' },
            field: { name: 'Ключ облачного прокси', description: 'Личный ключ. Хранится на этом устройстве; не публикуйте его.' },
            onChange: logout
        });

    }

    /* ====================================================
     *  Bootstrap
     * ==================================================== */
    function registerManifest() {
        try {
            if (!Lampa.Manifest) Lampa.Manifest = {};
            // Старые билды: plugins — объект; новые: массив.
            if (Array.isArray(Lampa.Manifest.plugins)) {
                var already = Lampa.Manifest.plugins.some(function (p) {
                    return p && p.component === manifest.component;
                });
                if (!already) Lampa.Manifest.plugins.push(manifest);
            } else if (typeof Lampa.Manifest.plugins === 'object' && Lampa.Manifest.plugins) {
                Lampa.Manifest.plugins[manifest.component] = manifest;
            } else {
                // Поле отсутствует — создаём как объект (наиболее совместимый вариант)
                var box = {};
                box[manifest.component] = manifest;
                Lampa.Manifest.plugins = box;
            }
        } catch (err) {
            console.log('REZKA', 'manifest register failed', err && err.message);
        }
    }

    function startPlugin() {
        if (window.rezka_plugin_started) return;
        ensureDefaults();
        // Register settings first: optional online integration cannot hide the menu.
        addSettings();
        window.rezka_plugin_started = true;
        registerManifest();
        registerComponent();
        try { addOnlineSource(); } catch (e) { console.log('REZKA online integration:', e.message); }
        try { addCardButton(); } catch (e) { console.log('REZKA card integration:', e.message); }
        Lampa.Noty.show('HDREZKA Cloud 1.0.4: меню зарегистрировано');
    }

    var bootstrapAttempts = 0;
    function bootstrap() {
        bootstrapAttempts++;
        if (typeof Lampa !== 'undefined' && Lampa.SettingsApi &&
            Lampa.SettingsApi.addComponent && Lampa.SettingsApi.addParam &&
            Lampa.Storage && Lampa.Component && Lampa.Listener && Lampa.Noty) {
            try { startPlugin(); }
            catch (e) {
                console.log('REZKA startup:', e.message);
                Lampa.Noty.show('HDREZKA Cloud 1.0.4: ошибка запуска: ' + e.message);
            }
            return;
        }
        if (bootstrapAttempts < 150) setTimeout(bootstrap, 200);
        else {
            console.log('REZKA: Lampa API unavailable after 30 seconds');
            if (typeof Lampa !== 'undefined' && Lampa.Noty) Lampa.Noty.show('HDREZKA: API Lampa не готов через 30 секунд');
        }
    }
    bootstrap();
})();
