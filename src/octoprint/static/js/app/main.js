$(function() {
        //~~ Lodash setup

        _.mixin({"sprintf": sprintf, "vsprintf": vsprintf});

        //~~ Logging setup

        log.setLevel(CONFIG_DEBUG ? "debug" : "info");

        //~~ setup browser and internal tab tracking (in 1.3.0 that will be
        //   much nicer with the global OctoPrint object...)

        var tabTracking = (function() {
            var exports = {
                browserTabVisibility: undefined,
                selectedTab: undefined
            };

            var browserVisibilityCallbacks = [];

            var getHiddenProp = function() {
                var prefixes = ["webkit", "moz", "ms", "o"];

                // if "hidden" is natively supported just return it
                if ("hidden" in document) {
                    return "hidden"
                }

                // otherwise loop over all the known prefixes until we find one
                var vendorPrefix = _.find(prefixes, function(prefix) {
                    return (prefix + "Hidden" in document);
                });
                if (vendorPrefix !== undefined) {
                    return vendorPrefix + "Hidden";
                }

                // nothing found
                return undefined;
            };

            var isHidden = function() {
                var prop = getHiddenProp();
                if (!prop) return false;

                return document[prop];
            };

            var updateBrowserVisibility = function() {
                var visible = !isHidden();
                exports.browserTabVisible = visible;
                _.each(browserVisibilityCallbacks, function(callback) {
                    callback(visible);
                })
            };

            // register for browser visibility tracking

            var prop = getHiddenProp();
            if (prop) {
                var eventName = prop.replace(/[H|h]idden/, "") + "visibilitychange";
                document.addEventListener(eventName, updateBrowserVisibility);

                updateBrowserVisibility();
            }

            // exports

            exports.isVisible = function() { return !isHidden() };
            exports.onBrowserVisibilityChange = function(callback) {
                browserVisibilityCallbacks.push(callback);
            };

            return exports;
        })();

        //~~ AJAX setup

        // work around a stupid iOS6 bug where ajax requests get cached and only work once, as described at
        // http://stackoverflow.com/questions/12506897/is-safari-on-ios-6-caching-ajax-results
        $.ajaxSetup({
            type: 'POST',
            headers: { "cache-control": "no-cache" }
        });

        // send the current UI API key with any request
        $.ajaxSetup({
            headers: {"X-Api-Key": UI_API_KEY}
        });

        //~~ Initialize file upload plugin

        $.widget("blueimp.fileupload", $.blueimp.fileupload, {
            options: {
                dropZone: null,
                pasteZone: null
            }
        });

        //~~ Initialize i18n

        var catalog = window["BABEL_TO_LOAD_" + LOCALE];
        if (catalog === undefined) {
            catalog = {messages: undefined, plural_expr: undefined, locale: undefined, domain: undefined}
        }
        babel.Translations.load(catalog).install();

        moment.locale(LOCALE);

        // Dummy translation requests for dynamic strings supplied by the backend
        var dummyTranslations = [
            // printer states
            gettext("Offline"),
            gettext("Opening serial port"),
            gettext("Detecting serial port"),
            gettext("Detecting baudrate"),
            gettext("Connecting"),
            gettext("Operational"),
            gettext("Printing from SD"),
            gettext("Sending file to SD"),
            gettext("Printing"),
            gettext("Paused"),
            gettext("Closed"),
            gettext("Transfering file to SD")
        ];

        //~~ Initialize PNotify

        PNotify.prototype.options.styling = "bootstrap2";
        PNotify.prototype.options.mouse_reset = false;

        //~~ Initialize view models

        // the view model map is our basic look up table for dependencies that may be injected into other view models
        var viewModelMap = {};

        // We put our tabTracking into the viewModelMap as a workaround until
        // our global OctoPrint object becomes available in 1.3.0. This way
        // we'll still be able to access it in our view models.
        //
        // NOTE TO DEVELOPERS: Do NOT depend on this dependency in your custom
        // view models. It is ONLY provided for the core application to be able
        // to backport a fix from the 1.3.0 development branch and WILL BE
        // REMOVED once 1.3.0 gets released without any fallback!
        //
        // TODO: Remove with release of 1.3.0
        viewModelMap.tabTracking = tabTracking;

        // Fix Function#name on browsers that do not support it (IE):
        // see: http://stackoverflow.com/questions/6903762/function-name-not-supported-in-ie
        if (!(function f() {}).name) {
            Object.defineProperty(Function.prototype, 'name', {
                get: function() {
                    return this.toString().match(/^\s*function\s*(\S*)\s*\(/)[1];
                }
            });
        }

        // helper to create a view model instance with injected constructor parameters from the view model map
        var _createViewModelInstance = function(viewModel, viewModelMap){
            var viewModelClass = viewModel[0];
            var viewModelParameters = viewModel[1];

            if (viewModelParameters != undefined) {
                if (!_.isArray(viewModelParameters)) {
                    viewModelParameters = [viewModelParameters];
                }

                // now we'll try to resolve all of the view model's constructor parameters via our view model map
                var constructorParameters = _.map(viewModelParameters, function(parameter){
                    return viewModelMap[parameter]
                });
            } else {
                constructorParameters = [];
            }

            if (_.some(constructorParameters, function(parameter) { return parameter === undefined; })) {
                var _extractName = function(entry) { return entry[0]; };
                var _onlyUnresolved = function(entry) { return entry[1] === undefined; };
                var missingParameters = _.map(_.filter(_.zip(viewModelParameters, constructorParameters), _onlyUnresolved), _extractName);
                log.debug("Postponing", viewModel[0].name, "due to missing parameters:", missingParameters);
                return;
            }

            // if we came this far then we could resolve all constructor parameters, so let's construct that view model
            log.debug("Constructing", viewModel[0].name, "with parameters:", viewModelParameters);
            return new viewModelClass(constructorParameters);
        };

        // map any additional view model bindings we might need to make
        var additionalBindings = {};
        _.each(OCTOPRINT_ADDITIONAL_BINDINGS, function(bindings) {
            var viewModelId = bindings[0];
            var viewModelBindTargets = bindings[1];
            if (!_.isArray(viewModelBindTargets)) {
                viewModelBindTargets = [viewModelBindTargets];
            }

            if (!additionalBindings.hasOwnProperty(viewModelId)) {
                additionalBindings[viewModelId] = viewModelBindTargets;
            } else {
                additionalBindings[viewModelId] = additionalBindings[viewModelId].concat(viewModelBindTargets);
            }
        });

        // helper for translating the name of a view model class into an identifier for the view model map
        var _getViewModelId = function(viewModel){
            var name = viewModel[0].name;
            return name.substr(0, 1).toLowerCase() + name.substr(1); // FooBarViewModel => fooBarViewModel
        };

        // instantiation loop, will make multiple passes over the list of unprocessed view models until all
        // view models have been successfully instantiated with all of their dependencies or no changes can be made
        // any more which means not all view models can be instantiated due to missing dependencies
        var unprocessedViewModels = OCTOPRINT_VIEWMODELS.slice();
        unprocessedViewModels = unprocessedViewModels.concat(ADDITIONAL_VIEWMODELS);

        var allViewModels = [];
        var allViewModelData = [];
        var pass = 1;
        log.info("Starting dependency resolution...");
        while (unprocessedViewModels.length > 0) {
            log.debug("Dependency resolution, pass #" + pass);
            var startLength = unprocessedViewModels.length;
            var postponed = [];

            // now try to instantiate every one of our as of yet unprocessed view model descriptors
            while (unprocessedViewModels.length > 0){
                var viewModel = unprocessedViewModels.shift();
                var viewModelId = _getViewModelId(viewModel);

                // make sure that we don't have two view models going by the same name
                if (_.has(viewModelMap, viewModelId)) {
                    log.error("Duplicate name while instantiating " + viewModelId);
                    continue;
                }

                var viewModelInstance = _createViewModelInstance(viewModel, viewModelMap);

                // our view model couldn't yet be instantiated, so postpone it for a bit
                if (viewModelInstance === undefined) {
                    postponed.push(viewModel);
                    continue;
                }

                // we could resolve the depdendencies and the view model is not defined yet => add it, it's now fully processed
                var viewModelBindTargets = viewModel[2];
                if (!_.isArray(viewModelBindTargets)) {
                    viewModelBindTargets = [viewModelBindTargets];
                }

                if (additionalBindings.hasOwnProperty(viewModelId)) {
                    viewModelBindTargets = viewModelBindTargets.concat(additionalBindings[viewModelId]);
                }

                allViewModelData.push([viewModelInstance, viewModelBindTargets]);
                allViewModels.push(viewModelInstance);
                viewModelMap[viewModelId] = viewModelInstance;
            }

            // anything that's now in the postponed list has to be readded to the unprocessedViewModels
            unprocessedViewModels = unprocessedViewModels.concat(postponed);

            // if we still have the same amount of items in our list of unprocessed view models it means that we
            // couldn't instantiate any more view models over a whole iteration, which in turn mean we can't resolve the
            // dependencies of remaining ones, so log that as an error and then quit the loop
            if (unprocessedViewModels.length == startLength) {
                log.error("Could not instantiate the following view models due to unresolvable dependencies:");
                _.each(unprocessedViewModels, function(entry) {
                    log.error(entry[0].name + " (missing: " + _.filter(entry[1], function(id) { return !_.has(viewModelMap, id); }).join(", ") + " )");
                });
                break;
            }

            log.debug("Dependency resolution pass #" + pass + " finished, " + unprocessedViewModels.length + " view models left to process");
            pass++;
        }
        log.info("... dependency resolution done");

        //~~ Custom knockout.js bindings

        ko.bindingHandlers.popover = {
            init: function(element, valueAccessor, allBindingsAccessor, viewModel, bindingContext) {
                var val = ko.utils.unwrapObservable(valueAccessor());

                var options = {
                    title: val.title,
                    animation: val.animation,
                    placement: val.placement,
                    trigger: val.trigger,
                    delay: val.delay,
                    content: val.content,
                    html: val.html
                };
                $(element).popover(options);
            }
        };

        ko.bindingHandlers.allowBindings = {
            init: function (elem, valueAccessor) {
                return { controlsDescendantBindings: !valueAccessor() };
            }
        };
        ko.virtualElements.allowedBindings.allowBindings = true;

        ko.bindingHandlers.slimScrolledForeach = {
            init: function(element, valueAccessor, allBindings, viewModel, bindingContext) {
                return ko.bindingHandlers.foreach.init(element, valueAccessor(), allBindings, viewModel, bindingContext);
            },
            update: function(element, valueAccessor, allBindings, viewModel, bindingContext) {
                setTimeout(function() {
                    $(element).slimScroll({scrollBy: 0});
                }, 10);
                return ko.bindingHandlers.foreach.update(element, valueAccessor(), allBindings, viewModel, bindingContext);
            }
        };

        ko.bindingHandlers.qrcode = {
            update: function(element, valueAccessor, allBindings, viewModel, bindingContext) {
                var val = ko.utils.unwrapObservable(valueAccessor());

                var defaultOptions = {
                    text: "",
                    size: 200,
                    fill: "#000",
                    background: null,
                    label: "",
                    fontname: "sans",
                    fontcolor: "#000",
                    radius: 0,
                    ecLevel: "L"
                };

                var options = {};
                _.each(defaultOptions, function(value, key) {
                    options[key] = ko.utils.unwrapObservable(val[key]) || value;
                });

                $(element).empty().qrcode(options);
            }
        };

        ko.bindingHandlers.invisible = {
            init: function(element, valueAccessor, allBindings, viewModel, bindingContext) {
                if (!valueAccessor()) return;
                ko.bindingHandlers.style.update(element, function() {
                    return { visibility: 'hidden' };
                })
            }
        };

        ko.bindingHandlers.copyWidth = {
            init: function(element, valueAccessor, allBindings, viewModel, bindingContext) {
                var node = ko.bindingHandlers.copyWidth._getReferenceNode(element, valueAccessor);
                ko.bindingHandlers.copyWidth._setWidth(node, element);
            },
            update: function(element, valueAccessor, allBindings, viewModel, bindingContext) {
                var node = ko.bindingHandlers.copyWidth._getReferenceNode(element, valueAccessor);
                ko.bindingHandlers.copyWidth._setWidth(node, element);
            },
            _setWidth: function(node, element) {
                var width = node.width();
                if (!width) return;
                if ($(element).width() == width) return;
                element.style.width = width + "px";
            },
            _getReferenceNode: function(element, valueAccessor) {
                var value = ko.utils.unwrapObservable(valueAccessor());
                if (!value) return;

                var parts = value.split(" ");
                var node = $(element);
                while (parts.length > 0) {
                    var part = parts.shift();
                    if (part == ":parent") {
                        node = node.parent();
                    } else {
                        var selector = part;
                        if (parts.length > 0) {
                            selector += " " + parts.join(" ");
                        }
                        node = $(selector, node);
                        break;
                    }
                }
                return node;
            }
        };

        ko.bindingHandlers.contextMenu = {
            init: function (element, valueAccessor, allBindingsAccessor, viewModel, bindingContext) {
                var val = ko.utils.unwrapObservable(valueAccessor());

                $(element).contextMenu(val);
            },
            update: function (element, valueAccessor, allBindingsAccessor, viewModel, bindingContext) {
                var val = ko.utils.unwrapObservable(valueAccessor());

                $(element).contextMenu(val);
            }
        };

        // Originally from Knockstrap
        // https://github.com/faulknercs/Knockstrap/blob/master/src/bindings/toggleBinding.js
        // License: MIT
        ko.bindingHandlers.toggle = {
            init: function (element, valueAccessor) {
                var value = valueAccessor();

                if (!ko.isObservable(value)) {
                    throw new Error('toggle binding should be used only with observable values');
                }

                $(element).on('click', function (event) {
                    event.preventDefault();

                    var previousValue = ko.utils.unwrapObservable(value);
                    value(!previousValue);
                });
            },

            update: function (element, valueAccessor) {
                ko.utils.toggleDomNodeCssClass(element, 'active', ko.utils.unwrapObservable(valueAccessor()));
            }
        };

        //~~ some additional hooks and initializations

        // make sure modals max out at the window height
        $.fn.modal.defaults.maxHeight = function(){
            // subtract the height of the modal header and footer
            return $(window).height() - 165;
        };

        // jquery plugin to select all text in an element
        // originally from: http://stackoverflow.com/a/987376
        $.fn.selectText = function() {
            var doc = document;
            var element = this[0];
            var range, selection;

            if (doc.body.createTextRange) {
                range = document.body.createTextRange();
                range.moveToElementText(element);
                range.select();
            } else if (window.getSelection) {
                selection = window.getSelection();
                range = document.createRange();
                range.selectNodeContents(element);
                selection.removeAllRanges();
                selection.addRange(range);
            }
        };

        $.fn.isChildOf = function (element) {
            return $(element).has(this).length > 0;
        };

        // from http://jsfiddle.net/KyleMit/X9tgY/
        $.fn.contextMenu = function (settings) {
            return this.each(function () {
                // Open context menu
                $(this).on("contextmenu", function (e) {
                    // return native menu if pressing control
                    if (e.ctrlKey) return;

                    $(settings.menuSelector)
                        .data("invokedOn", $(e.target))
                        .data("contextParent", $(this))
                        .show()
                        .css({
                            position: "fixed",
                            left: getMenuPosition(e.clientX, 'width', 'scrollLeft'),
                            top: getMenuPosition(e.clientY, 'height', 'scrollTop'),
                            "z-index": 9999
                        }).off('click')
                        .on('click', function (e) {
                            if (e.target.tagName.toLowerCase() == "input")
                                return;

                            $(this).hide();

                            settings.menuSelected.call(this, $(this).data('invokedOn'), $(this).data('contextParent'), $(e.target));
                        });

                    return false;
                });

                //make sure menu closes on any click
                $(document).click(function () {
                    $(settings.menuSelector).hide();
                });
            });

            function getMenuPosition(mouse, direction, scrollDir) {
                var win = $(window)[direction](),
                    scroll = $(window)[scrollDir](),
                    menu = $(settings.menuSelector)[direction](),
                    position = mouse + scroll;

                // opening menu would pass the side of the page
                if (mouse + menu > win && menu < mouse)
                    position -= menu;

                return position;
            }
        };

        // Use bootstrap tabdrop for tabs and pills
        $('.nav-pills, .nav-tabs').tabdrop();

        // Allow components to react to tab change
        var onTabChange = function(current, previous) {
            log.debug("Selected OctoPrint tab changed: previous = " + previous + ", current = " + current);
            tabTracking.selectedTab = current;

            _.each(allViewModels, function(viewModel) {
                if (viewModel.hasOwnProperty("onTabChange")) {
                    viewModel.onTabChange(current, previous);
                }
            });
        };

        var tabs = $('#tabs a[data-toggle="tab"]');
        tabs.on('show', function (e) {
            var current = e.target.hash;
            var previous = e.relatedTarget.hash;
            onTabChange(current, previous);
        });

        tabs.on('shown', function (e) {
            var current = e.target.hash;
            var previous = e.relatedTarget.hash;

            var tabContainer = $('#tab-container');
            var sidebarContainer = $('#sidebar-container');
            var workbControls = $('#workbench_ctrls_wrapper');
            if (current == '#workbench') {

                tabContainer.removeClass('span8');
                tabContainer.addClass('span9');

                sidebarContainer.removeClass('span4');
                sidebarContainer.addClass('span3');

                workbControls.css('display', 'block');
            } else {
                tabContainer.removeClass('span9');
                tabContainer.addClass('span9');

                sidebarContainer.removeClass('span3');
                sidebarContainer.addClass('span3');

                workbControls.css('display', 'none');
            }


            _.each(allViewModels, function(viewModel) {
                if (viewModel.hasOwnProperty("onAfterTabChange")) {
                    viewModel.onAfterTabChange(current, previous);
                }
            });
        });

        onTabChange(OCTOPRINT_INITIAL_TAB);

        // Fix input element click problems on dropdowns
        $(".dropdown input, .dropdown label").click(function(e) {
            e.stopPropagation();
        });

        // prevent default action for drag-n-drop
        $(document).bind("drop dragover", function (e) {
            e.preventDefault();
        });

        // reload overlay
        $("#reloadui_overlay_reload").click(function() { location.reload(); });

        //~~ view model binding

        var bindViewModels = function() {
            log.info("Going to bind " + allViewModelData.length + " view models...");
            _.each(allViewModelData, function(viewModelData) {
                if (!Array.isArray(viewModelData) || viewModelData.length != 2) {
                    return;
                }

                var viewModel = viewModelData[0];
                var targets = viewModelData[1];

                if (targets === undefined) {
                    return;
                }

                if (!_.isArray(targets)) {
                    targets = [targets];
                }

                if (viewModel.hasOwnProperty("onBeforeBinding")) {
                    viewModel.onBeforeBinding();
                }

                if (targets != undefined) {
                    if (!_.isArray(targets)) {
                        targets = [targets];
                    }

                    _.each(targets, function(target) {
                        if (target == undefined) {
                            return;
                        }

                        var object;
                        if (!(target instanceof jQuery)) {
                            object = $(target);
                        } else {
                            object = target;
                        }

                        if (object == undefined || !object.length) {
                            log.info("Did not bind view model", viewModel.constructor.name, "to target", target, "since it does not exist");
                            return;
                        }

                        var element = object.get(0);
                        if (element == undefined) {
                            log.info("Did not bind view model", viewModel.constructor.name, "to target", target, "since it does not exist");
                            return;
                        }

                        try {
                            ko.applyBindings(viewModel, element);
                            log.debug("View model", viewModel.constructor.name, "bound to", target);
                        } catch (exc) {
                            log.error("Could not bind view model", viewModel.constructor.name, "to target", target, ":", (exc.stack || exc));
                        }
                    });
                }

                if (viewModel.hasOwnProperty("onAfterBinding")) {
                    viewModel.onAfterBinding();
                }
            });

            _.each(allViewModels, function(viewModel) {
                if (viewModel.hasOwnProperty("onAllBound")) {
                    viewModel.onAllBound(allViewModels);
                }
            });
            log.info("... binding done");

            // startup complete
            _.each(allViewModels, function(viewModel) {
                if (viewModel.hasOwnProperty("onStartupComplete")) {
                    viewModel.onStartupComplete();
                }
            });

            // make sure we can track the browser tab visibility
            tabTracking.onBrowserVisibilityChange(function(status) {
                log.debug("Browser tab is now " + (status ? "visible" : "hidden"));
                _.each(allViewModels, function(viewModel) {
                    if (viewModel.hasOwnProperty("onBrowserTabVisibilityChange")) {
                        viewModel.onBrowserTabVisibilityChange(status);
                    }
                });
            });

            log.info("Application startup complete");
        };

        if (!_.has(viewModelMap, "settingsViewModel")) {
            throw new Error("settingsViewModel is missing, can't run UI")
        }

        var dataUpdaterConnectCallback = function() {
            log.info("Finalizing application startup");

            //~~ Starting up the app

            _.each(allViewModels, function(viewModel) {
                if (viewModel.hasOwnProperty("onStartup")) {
                    viewModel.onStartup();
                }
            });

            viewModelMap["settingsViewModel"].requestData(bindViewModels);
        };

        log.info("Initial application setup done, connecting to server...");
        var dataUpdater = new DataUpdater(allViewModels);
        dataUpdater.connect(dataUpdaterConnectCallback);

        //****************************************************************/
        //****************        BEEweb JS hacks     ********************/
        //****************************************************************/
        $('#state_wrapper').on('shown.bs.collapse', function (e) {
            // Sets the panel height as vertical offset to adjust the 3D canvas
            BEEwb.main.topPanelVerticalOffset = $('#state').height();
        });

        $('#state_wrapper').on('hidden.bs.collapse', function (e) {
            // Resets the offset to adjust the 3D canvas
            BEEwb.main.topPanelVerticalOffset = 0;
        });

        $('#slicing_configuration_dialog .form-horizontal .control-label').on('click', function(){
            $(this).toggleClass('closed');
        })
    }
);

