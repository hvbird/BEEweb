# coding=utf-8
from __future__ import absolute_import

__author__ = "Gina Häußge <osd@foosel.net>"
__license__ = 'GNU Affero General Public License http://www.gnu.org/licenses/agpl.html'
__copyright__ = "Copyright (C) 2015 The OctoPrint Project - Released under terms of the AGPLv3 License"

import os

from collections import defaultdict
from flask import request, g, url_for, make_response, render_template, send_from_directory, redirect

import octoprint.plugin

from octoprint.server import app, userManager, pluginManager, gettext, \
	debug, LOCALES, VERSION, DISPLAY_VERSION, UI_API_KEY, BRANCH, preemptiveCache, \
	NOT_MODIFIED
from octoprint.settings import settings
from octoprint.filemanager import get_all_extensions

import re

from . import util

import logging
_logger = logging.getLogger(__name__)

_valid_id_re = re.compile("[a-z_]+")
_valid_div_re = re.compile("[a-zA-Z_-]+")

@app.route("/")
@util.flask.preemptively_cached(cache=preemptiveCache,
                                data=lambda: dict(path=request.path, base_url=request.url_root, query_string="l10n={}".format(g.locale.language) if g.locale else "en"),
                                unless=lambda: request.url_root in settings().get(["server", "preemptiveCache", "exceptions"]))
@util.flask.conditional(lambda: _check_etag_and_lastmodified_for_index(), NOT_MODIFIED)
@util.flask.cached(timeout=-1,
                   refreshif=lambda cached: _validate_cache_for_index(cached),
                   key=lambda: "view:{}:{}".format(request.base_url, g.locale.language if g.locale else "en"),
                   unless_response=lambda response: util.flask.cache_check_response_headers(response))
@util.flask.etagged(lambda _: _compute_etag_for_index())
@util.flask.lastmodified(lambda _: _compute_date_for_index())
def index():
	#~~ a bunch of settings

	enable_gcodeviewer = settings().getBoolean(["gcodeViewer", "enabled"])
	enable_timelapse = (settings().get(["webcam", "snapshot"]) and settings().get(["webcam", "ffmpeg"]))
	enable_systemmenu = settings().get(["system"]) is not None and settings().get(["system", "actions"]) is not None
	enable_accesscontrol = userManager.enabled
	preferred_stylesheet = settings().get(["devel", "stylesheet"])
	locales = dict((l.language, dict(language=l.language, display=l.display_name, english=l.english_name)) for l in LOCALES)

	##~~ prepare templates

	templates = defaultdict(lambda: dict(order=[], entries=dict()))

	# rules for transforming template configs to template entries
	template_rules = dict(
		navbar=dict(div=lambda x: "navbar_plugin_" + x, template=lambda x: x + "_navbar.jinja2", to_entry=lambda data: data),
		sidebar=dict(div=lambda x: "sidebar_plugin_" + x, template=lambda x: x + "_sidebar.jinja2", to_entry=lambda data: (data["name"], data)),
		tab=dict(div=lambda x: "tab_plugin_" + x, template=lambda x: x + "_tab.jinja2", to_entry=lambda data: (data["name"], data)),
		settings=dict(div=lambda x: "settings_plugin_" + x, template=lambda x: x + "_settings.jinja2", to_entry=lambda data: (data["name"], data)),
		usersettings=dict(div=lambda x: "usersettings_plugin_" + x, template=lambda x: x + "_usersettings.jinja2", to_entry=lambda data: (data["name"], data)),
		generic=dict(template=lambda x: x + ".jinja2", to_entry=lambda data: data)
	)

	# sorting orders
	template_sorting = dict(
		navbar=dict(add="prepend", key=None),
		sidebar=dict(add="append", key="name"),
		tab=dict(add="append", key="name"),
		settings=dict(add="custom_append", key="name", custom_add_entries=lambda missing: dict(section_plugins=(gettext("Plugins"), None)), custom_add_order=lambda missing: ["section_plugins"] + missing),
		usersettings=dict(add="append", key="name"),
		generic=dict(add="append", key=None)
	)

	hooks = pluginManager.get_hooks("octoprint.ui.web.templatetypes")
	for name, hook in hooks.items():
		try:
			result = hook(dict(template_sorting), dict(template_rules))
		except:
			_logger.exception("Error while retrieving custom template type definitions from plugin {name}".format(**locals()))
		else:
			if not isinstance(result, list):
				continue

			for entry in result:
				if not isinstance(entry, tuple) or not len(entry) == 3:
					continue

				key, order, rule = entry

				# order defaults
				if "add" not in order:
					order["add"] = "prepend"
				if "key" not in order:
					order["key"] = "name"

				# rule defaults
				if "div" not in rule:
					# default div name: <hook plugin>_<template_key>_plugin_<plugin>
					div = "{name}_{key}_plugin_".format(**locals())
					rule["div"] = lambda x: div + x
				if "template" not in rule:
					# default template name: <plugin>_plugin_<hook plugin>_<template key>.jinja2
					template = "_plugin_{name}_{key}.jinja2".format(**locals())
					rule["template"] = lambda x: x + template
				if "to_entry" not in rule:
					# default to_entry assumes existing "name" property to be used as label for 2-tuple entry data structure (<name>, <properties>)
					rule["to_entry"] = lambda data: (data["name"], data)

				template_rules["plugin_" + name + "_" + key] = rule
				template_sorting["plugin_" + name + "_" + key] = order
	template_types = template_rules.keys()

	# navbar

	templates["navbar"]["entries"] = dict(
		settings=dict(template="navbar/settings.jinja2", _div="navbar_settings", styles=["display: none"], data_bind="visible: loginState.isAdmin"),
		maintenance=dict(template="navbar/maintenance.jinja2", _div="navbar_maintenance")
	)
	if enable_accesscontrol:
		templates["navbar"]["entries"]["login"] = dict(template="navbar/login.jinja2", _div="navbar_login", classes=["dropdown"], custom_bindings=False)
	if enable_systemmenu:
		templates["navbar"]["entries"]["systemmenu"] = dict(template="navbar/systemmenu.jinja2", _div="navbar_systemmenu", styles=["display: none"], classes=["dropdown"], data_bind="visible: loginState.isAdmin", custom_bindings=False)

	# sidebar

	templates["sidebar"]["entries"]= dict(
		workbench_controls=(gettext("Workbench Controls"), dict(template="sidebar/workbench_controls.jinja2", _div="workbench_ctrls", styles_wrapper=["display: none"], icon="edit")),
		connection=(gettext("Connection"), dict(template="sidebar/connection.jinja2", _div="connection", icon="signal", styles_wrapper=["display: none"], data_bind="visible: loginState.isAdmin")),
		#state=(gettext("State"), dict(template="sidebar/state.jinja2", _div="state", icon="info-sign")),
		files=(gettext("Files"), dict(template="sidebar/files.jinja2", _div="files", icon="list", classes_content=["overflow_visible"], template_header="sidebar/files_header.jinja2"))
	)

	# tabs

	templates["tab"]["entries"] = dict(
		workbench=(gettext("Workbench"), dict(template="tabs/workbench.jinja2", _div="workbench")),
		temperature=(gettext("Temperature"), dict(template="tabs/temperature.jinja2", _div="temp")),
		control=(gettext("Control"), dict(template="tabs/control.jinja2", _div="control")),
		terminal=(gettext("Terminal"), dict(template="tabs/terminal.jinja2", _div="term")),
	)
	if enable_gcodeviewer:
		templates["tab"]["entries"]["gcodeviewer"] = (gettext("GCode Viewer"), dict(template="tabs/gcodeviewer.jinja2", _div="gcode"))
	if enable_timelapse:
		templates["tab"]["entries"]["timelapse"] = (gettext("Timelapse"), dict(template="tabs/timelapse.jinja2", _div="timelapse"))

	# settings dialog

	templates["settings"]["entries"] = dict(
		section_printer=(gettext("Printer"), None),

		#serial=(gettext("Serial Connection"), dict(template="dialogs/settings/serialconnection.jinja2", _div="settings_serialConnection", custom_bindings=False)),
		printerprofiles=(gettext("Printer Profiles"), dict(template="dialogs/settings/printerprofiles.jinja2", _div="settings_printerProfiles", custom_bindings=False)),
		temperatures=(gettext("Temperatures"), dict(template="dialogs/settings/temperatures.jinja2", _div="settings_temperature", custom_bindings=False)),
		terminalfilters=(gettext("Terminal Filters"), dict(template="dialogs/settings/terminalfilters.jinja2", _div="settings_terminalFilters", custom_bindings=False)),
		gcodescripts=(gettext("GCODE Scripts"), dict(template="dialogs/settings/gcodescripts.jinja2", _div="settings_gcodeScripts", custom_bindings=False)),

		section_features=(gettext("Features"), None),

		features=(gettext("Features"), dict(template="dialogs/settings/features.jinja2", _div="settings_features", custom_bindings=False)),
		webcam=(gettext("Webcam"), dict(template="dialogs/settings/webcam.jinja2", _div="settings_webcam", custom_bindings=False)),
		api=(gettext("API"), dict(template="dialogs/settings/api.jinja2", _div="settings_api", custom_bindings=False)),

		section_beeweb=(gettext("BEEweb"), None),

		folders=(gettext("Folders"), dict(template="dialogs/settings/folders.jinja2", _div="settings_folders", custom_bindings=False)),
		appearance=(gettext("Appearance"), dict(template="dialogs/settings/appearance.jinja2", _div="settings_appearance", custom_bindings=False)),
		logs=(gettext("Logs"), dict(template="dialogs/settings/logs.jinja2", _div="settings_logs")),
		server=(gettext("Server"), dict(template="dialogs/settings/server.jinja2", _div="settings_server", custom_bindings=False)),
	)
	if enable_accesscontrol:
		templates["settings"]["entries"]["accesscontrol"] = (gettext("Access Control"), dict(template="dialogs/settings/accesscontrol.jinja2", _div="settings_users", custom_bindings=False))

	# user settings dialog

	if enable_accesscontrol:
		templates["usersettings"]["entries"] = dict(
			access=(gettext("Access"), dict(template="dialogs/usersettings/access.jinja2", _div="usersettings_access", custom_bindings=False)),
			interface=(gettext("Interface"), dict(template="dialogs/usersettings/interface.jinja2", _div="usersettings_interface", custom_bindings=False)),
		)

	# extract data from template plugins

	template_plugins = pluginManager.get_implementations(octoprint.plugin.TemplatePlugin)

	plugin_vars = dict()
	plugin_names = set()
	for implementation in template_plugins:
		name = implementation._identifier
		plugin_names.add(name)

		try:
			vars = implementation.get_template_vars()
			configs = implementation.get_template_configs()
		except:
			_logger.exception("Error while retrieving template data for plugin {}, ignoring it".format(name))
			continue

		if not isinstance(vars, dict):
			vars = dict()
		if not isinstance(configs, (list, tuple)):
			configs = []

		for var_name, var_value in vars.items():
			plugin_vars["plugin_" + name + "_" + var_name] = var_value

		includes = _process_template_configs(name, implementation, configs, template_rules)

		for t in template_types:
			for include in includes[t]:
				if t == "navbar" or t == "generic":
					data = include
				else:
					data = include[1]

				key = data["_key"]
				if "replaces" in data:
					key = data["replaces"]
				templates[t]["entries"][key] = include

	#~~ order internal templates and plugins

	# make sure that
	# 1) we only have keys in our ordered list that we have entries for and
	# 2) we have all entries located somewhere within the order

	for t in template_types:
		default_order = settings().get(["appearance", "components", "order", t], merged=True, config=dict()) or []
		configured_order = settings().get(["appearance", "components", "order", t], merged=True) or []
		configured_disabled = settings().get(["appearance", "components", "disabled", t]) or []

		# first create the ordered list of all component ids according to the configured order
		templates[t]["order"] = [x for x in configured_order if x in templates[t]["entries"] and not x in configured_disabled]

		# now append the entries from the default order that are not already in there
		templates[t]["order"] += [x for x in default_order if not x in templates[t]["order"] and x in templates[t]["entries"] and not x in configured_disabled]

		all_ordered = set(templates[t]["order"])
		all_disabled = set(configured_disabled)

		# check if anything is missing, if not we are done here
		missing_in_order = set(templates[t]["entries"].keys()).difference(all_ordered).difference(all_disabled)
		if len(missing_in_order) == 0:
			continue

		# finally add anything that's not included in our order yet
		sorted_missing = list(missing_in_order)
		if template_sorting[t]["key"] is not None:
			# default extractor: works with entries that are dicts and entries that are 2-tuples with the
			# entry data at index 1
			def extractor(item, key):
				if isinstance(item, dict) and key in item:
					return item[key]
				elif isinstance(item, tuple) and len(item) > 1 and isinstance(item[1], dict) and key in item[1]:
					return item[1][key]

				return None

			# if template type provides custom extractor, make sure its exceptions are handled
			if "key_extractor" in template_sorting[t] and callable(template_sorting[t]["key_extractor"]):
				def create_safe_extractor(extractor):
					def f(x, k):
						try:
							return extractor(x, k)
						except:
							_logger.exception("Error while extracting sorting keys for template {}".format(t))
							return None
					return f
				extractor = create_safe_extractor(template_sorting[t]["key_extractor"])

			sort_key = template_sorting[t]["key"]
			sorted_missing = sorted(missing_in_order, key=lambda x: extractor(templates[t]["entries"][x], sort_key))

		if template_sorting[t]["add"] == "prepend":
			templates[t]["order"] = sorted_missing + templates[t]["order"]
		elif template_sorting[t]["add"] == "append":
			templates[t]["order"] += sorted_missing
		elif template_sorting[t]["add"] == "custom_prepend" and "custom_add_entries" in template_sorting[t] and "custom_add_order" in template_sorting[t]:
			templates[t]["entries"].update(template_sorting[t]["custom_add_entries"](sorted_missing))
			templates[t]["order"] = template_sorting[t]["custom_add_order"](sorted_missing) + templates[t]["order"]
		elif template_sorting[t]["add"] == "custom_append" and "custom_add_entries" in template_sorting[t] and "custom_add_order" in template_sorting[t]:
			templates[t]["entries"].update(template_sorting[t]["custom_add_entries"](sorted_missing))
			templates[t]["order"] += template_sorting[t]["custom_add_order"](sorted_missing)

	#~~ prepare full set of template vars for rendering

	first_run = settings().getBoolean(["server", "firstRun"]) and userManager.enabled and not userManager.hasBeenCustomized()
	render_kwargs = dict(
		webcamStream=settings().get(["webcam", "stream"]),
		enableTemperatureGraph=settings().get(["feature", "temperatureGraph"]),
		enableAccessControl=userManager.enabled,
		enableSdSupport=settings().get(["feature", "sdSupport"]),
		firstRun=first_run,
		debug=debug,
		version=VERSION,
		display_version=DISPLAY_VERSION,
		branch=BRANCH,
		gcodeMobileThreshold=settings().get(["gcodeViewer", "mobileSizeThreshold"]),
		gcodeThreshold=settings().get(["gcodeViewer", "sizeThreshold"]),
		uiApiKey=UI_API_KEY,
		templates=templates,
		pluginNames=plugin_names,
		locales=locales,
		supportedExtensions=map(lambda ext: ".{}".format(ext), get_all_extensions())
	)
	render_kwargs.update(plugin_vars)

	#~~ render!

	response = make_response(render_template(
		"index.jinja2",
		**render_kwargs
	))

	if first_run:
		response = util.flask.add_non_caching_response_headers(response)

	return response


def _process_template_configs(name, implementation, configs, rules):
	from jinja2.exceptions import TemplateNotFound

	counters = defaultdict(lambda: 1)
	includes = defaultdict(list)

	for config in configs:
		if not isinstance(config, dict):
			continue
		if not "type" in config:
			continue

		template_type = config["type"]
		del config["type"]

		if not template_type in rules:
			continue
		rule = rules[template_type]

		data = _process_template_config(name, implementation, rule, config=config, counter=counters[template_type])
		if data is None:
			continue

		includes[template_type].append(rule["to_entry"](data))
		counters[template_type] += 1

	for template_type in rules:
		if len(includes[template_type]) == 0:
			# if no template of that type was added by the config, we'll try to use the default template name
			rule = rules[template_type]
			data = _process_template_config(name, implementation, rule)
			if data is not None:
				try:
					app.jinja_env.get_or_select_template(data["template"])
				except TemplateNotFound:
					pass
				except:
					_logger.exception("Error in template {}, not going to include it".format(data["template"]))
				else:
					includes[template_type].append(rule["to_entry"](data))

	return includes


def _process_template_config(name, implementation, rule, config=None, counter=1):
	if "mandatory" in rule:
		for mandatory in rule["mandatory"]:
			if not mandatory in config:
				return None

	if config is None:
		config = dict()
	data = dict(config)

	if not "suffix" in data and counter > 1:
		data["suffix"] = "_%d" % counter

	if "div" in data:
		data["_div"] = data["div"]
	elif "div" in rule:
		data["_div"] = rule["div"](name)
		if "suffix" in data:
			data["_div"] = data["_div"] + data["suffix"]
		if not _valid_div_re.match(data["_div"]):
			_logger.warn("Template config {} contains invalid div identifier {}, skipping it".format(name, data["_div"]))
			return None

	if not "template" in data:
		data["template"] = rule["template"](name)

	if not "name" in data:
		data["name"] = implementation._plugin_name

	if not "custom_bindings" in data or data["custom_bindings"]:
		data_bind = "allowBindings: true"
		if "data_bind" in data:
			data_bind = data_bind + ", " + data["data_bind"]
		data_bind = data_bind.replace("\"", "\\\"")
		data["data_bind"] = data_bind

	data["_key"] = "plugin_" + name
	if "suffix" in data:
		data["_key"] += data["suffix"]

	return data


@app.route("/robots.txt")
@util.flask.cached(timeout=-1)
def robotsTxt():
	return send_from_directory(app.static_folder, "robots.txt")


@app.route("/i18n/<string:locale>/<string:domain>.js")
@util.flask.conditional(lambda: _check_etag_and_lastmodified_for_i18n(), NOT_MODIFIED)
@util.flask.etagged(lambda _: _compute_etag_for_i18n(request.view_args["locale"], request.view_args["domain"]))
@util.flask.lastmodified(lambda _: _compute_date_for_i18n(request.view_args["locale"], request.view_args["domain"]))
def localeJs(locale, domain):
	messages = dict()
	plural_expr = None

	if locale != "en":
		messages, plural_expr = _get_translations(locale, domain)

	catalog = dict(
		messages=messages,
		plural_expr=plural_expr,
		locale=locale,
		domain=domain
	)

	from flask import Response
	return Response(render_template("i18n.js.jinja2", catalog=catalog), content_type="application/x-javascript; charset=utf-8")


@app.route("/plugin_assets/<string:name>/<path:filename>")
def plugin_assets(name, filename):
	return redirect(url_for("plugin." + name + ".static", filename=filename))


def _compute_etag_for_index(files=None, lastmodified=None):
	if files is None:
		files = _files_for_index()
	if lastmodified is None:
		lastmodified = _compute_date(files)
	if lastmodified and not isinstance(lastmodified, basestring):
		from werkzeug.http import http_date
		lastmodified = http_date(lastmodified)

	from octoprint import __version__
	from octoprint.server import UI_API_KEY

	import hashlib
	hash = hashlib.sha1()
	hash.update(__version__)
	hash.update(UI_API_KEY)
	hash.update(",".join(sorted(files)))
	if lastmodified:
		hash.update(lastmodified)
	return hash.hexdigest()


def _compute_etag_for_i18n(locale, domain, files=None, lastmodified=None):
	if files is None:
		files = _get_all_translationfiles(locale, domain)
	if lastmodified is None:
		lastmodified = _compute_date(files)
	if lastmodified and not isinstance(lastmodified, basestring):
		from werkzeug.http import http_date
		lastmodified = http_date(lastmodified)

	import hashlib
	hash = hashlib.sha1()
	hash.update(",".join(sorted(files)))
	if lastmodified:
		hash.update(lastmodified)
	return hash.hexdigest()


def _compute_date_for_i18n(locale, domain):
	return _compute_date(_get_all_translationfiles(locale, domain))


def _compute_date_for_index():
	return _compute_date(_files_for_index())


def _validate_cache_for_index(cached):
	no_cache_headers = util.flask.cache_check_headers()
	refresh_flag = "_refresh" in request.values
	etag_different = _compute_etag_for_index() != cached.get_etag()[0]

	return no_cache_headers or refresh_flag or etag_different


def _files_for_index():
	"""
	Collects all paths of files that the index page depends on.

	The relevant files are:

	  * all jinja2 templates: they might be used within the index page, so
	    any changes here change the rendering outcome
	  * all defined assets: if one of them changes, the webassets bundle will
	    be regenerated and hence the URL included in the cached page won't be
	    valid anymore
	  * all translation files used for our current locale: if any of those change
	    we also need to re-render
	"""

	templates = _get_all_templates()
	assets = _get_all_assets()
	translations = _get_all_translationfiles(g.locale.language if g.locale else "en", "messages")
	return sorted(set(templates + assets + translations))


def _compute_date(files):
	from datetime import datetime
	timestamps = map(lambda path: os.stat(path).st_mtime, files)
	max_timestamp = max(*timestamps) if timestamps else None
	if max_timestamp:
		# we set the micros to 0 since microseconds are not speced for HTTP
		max_timestamp = datetime.fromtimestamp(max_timestamp).replace(microsecond=0)
	return max_timestamp


def _check_etag_and_lastmodified_for_index():
	files = _files_for_index()
	lastmodified = _compute_date(files)
	lastmodified_ok = util.flask.check_lastmodified(lastmodified)
	etag_ok = util.flask.check_etag(_compute_etag_for_index(files, lastmodified))
	return etag_ok and lastmodified_ok


def _check_etag_and_lastmodified_for_i18n():
	locale = request.view_args["locale"]
	domain = request.view_args["domain"]

	etag_ok = util.flask.check_etag(_compute_etag_for_i18n(request.view_args["locale"], request.view_args["domain"]))

	lastmodified = _compute_date_for_i18n(locale, domain)
	lastmodified_ok = lastmodified is None or util.flask.check_lastmodified(lastmodified)

	return etag_ok and lastmodified_ok


def _get_all_templates():
	from octoprint.util.jinja import get_all_template_paths
	return get_all_template_paths(app.jinja_loader)


def _get_all_assets():
	from octoprint.util.jinja import get_all_asset_paths
	return get_all_asset_paths(app.jinja_env.assets_environment)


def _get_all_translationfiles(locale, domain):
	from flask import _request_ctx_stack

	def get_po_path(basedir, locale, domain):
		path = os.path.join(basedir, locale)
		if not os.path.isdir(path):
			return None

		path = os.path.join(path, "LC_MESSAGES", "{domain}.po".format(**locals()))
		if not os.path.isfile(path):
			return None

		return path

	po_files = []

	user_base_path = os.path.join(settings().getBaseFolder("translations"))
	user_plugin_path = os.path.join(user_base_path, "_plugins")

	# plugin translations
	plugins = octoprint.plugin.plugin_manager().enabled_plugins
	for name, plugin in plugins.items():
		dirs = [os.path.join(user_plugin_path, name), os.path.join(plugin.location, 'translations')]
		for dirname in dirs:
			if not os.path.isdir(dirname):
				continue

			po_file = get_po_path(dirname, locale, domain)
			if po_file:
				po_files.append(po_file)
				break

	# core translations
	ctx = _request_ctx_stack.top
	base_path = os.path.join(ctx.app.root_path, "translations")

	dirs = [user_base_path, base_path]
	for dirname in dirs:
		po_file = get_po_path(dirname, locale, domain)
		if po_file:
			po_files.append(po_file)
			break

	return po_files


def _get_translations(locale, domain):
	from babel.messages.pofile import read_po
	from octoprint.util import dict_merge

	messages = dict()
	plural_expr = None

	def messages_from_po(path, locale, domain):
		messages = dict()
		with file(path) as f:
			catalog = read_po(f, locale=locale, domain=domain)

			for message in catalog:
				message_id = message.id
				if isinstance(message_id, (list, tuple)):
					message_id = message_id[0]
				messages[message_id] = message.string

		return messages, catalog.plural_expr

	po_files = _get_all_translationfiles(locale, domain)
	for po_file in po_files:
		po_messages, plural_expr = messages_from_po(po_file, locale, domain)
		if po_messages is not None:
			messages = dict_merge(messages, po_messages)

	return messages, plural_expr


@app.route("/wifi")
def wifi_config():

	import datetime
	locales = dict((l.language, dict(language=l.language, display=l.display_name, english=l.english_name)) for l in LOCALES)

	render_kwargs = dict(
		version=VERSION,
		display_version=DISPLAY_VERSION,
		branch=BRANCH,
		locales=locales
	)

	response = make_response(render_template(
		"wifi.jinja2",
		**render_kwargs
	))
	response.headers["Last-Modified"] = datetime.datetime.now()

	return response
