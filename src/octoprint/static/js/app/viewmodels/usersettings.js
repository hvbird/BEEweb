$(function() {
    function UserSettingsViewModel(parameters) {
        var self = this;

        self.loginState = parameters[0];
        self.users = parameters[1];

        self.userSettingsDialog = undefined;

        var auto_locale = {language: "_default", display: gettext("Site default"), english: undefined};
        self.locales = ko.observableArray([auto_locale].concat(_.sortBy(_.values(AVAILABLE_LOCALES), function(n) {
            return n.display;
        })));
        self.locale_languages = _.keys(AVAILABLE_LOCALES);

        self.access_password = ko.observable(undefined);
        self.access_repeatedPassword = ko.observable(undefined);
        self.access_apikey = ko.observable(undefined);
        self.interface_language = ko.observable(undefined);
        self.devMode = ko.observable();

        self.currentUser = ko.observable(undefined);
        self.currentUser.subscribe(function(newUser) {
            self.access_password(undefined);
            self.access_repeatedPassword(undefined);
            self.access_apikey(undefined);
            self.interface_language("_default");

            if (newUser != undefined) {
                self.access_apikey(newUser.apikey);
                if (newUser.settings.hasOwnProperty("interface") && newUser.settings.interface.hasOwnProperty("language")) {
                    self.interface_language(newUser.settings.interface.language);
                }
            }
        });

        self.passwordMismatch = ko.pureComputed(function() {
            return self.access_password() != self.access_repeatedPassword();
        });

        self.show = function(user) {
            if (!CONFIG_ACCESS_CONTROL) return;

            if (user == undefined) {
                user = self.loginState.currentUser();
            }

            self.currentUser(user);
            // loads user settings
            $.ajax({
                url: API_BASEURL + "users/" + user.name + "/settings",
                type: "GET",
                contentType: "application/json; charset=UTF-8",
                success: function (settings) {
                debugger;
                    self.devMode(settings.interface.dev_mode)
                }
            });

            self.userSettingsDialog.modal("show");
        };

        self.save = function() {
            if (!CONFIG_ACCESS_CONTROL) return;

            if (self.access_password() && !self.passwordMismatch()) {
                self.users.updatePassword(self.currentUser().name, self.access_password(), function(){});
            }

            var settings = {
                "interface": {
                    "language": self.interface_language(),
                    "dev_mode": self.devMode()
                }
            };
            self.updateSettings(self.currentUser().name, settings)
                .done(function() {
                    // close dialog
                    self.currentUser(undefined);
                    self.userSettingsDialog.modal("hide");
                    self.loginState.reloadUser();
                });
        };

        self.generateApikey = function() {
            if (!CONFIG_ACCESS_CONTROL) return;
            self.users.generateApikey(self.currentUser().name, function(response) {
                self.access_apikey(response.apikey);
            });
        };

        self.deleteApikey = function() {
            if (!CONFIG_ACCESS_CONTROL) return;
            self.users.deleteApikey(self.currentUser().name, function() {
                self.access_apikey(undefined);
            });
        };

        self.updateSettings = function(username, settings) {
            return OctoPrint.users.saveSettings(username, settings);
        };

        self.saveEnabled = function() {
            return !self.passwordMismatch();
        };

        self.onStartup = function() {
            self.userSettingsDialog = $("#usersettings_dialog");
        };

        self.onAllBound = function(allViewModels) {
            self.userSettingsDialog.on('show', function() {
                callViewModels(allViewModels, "onUserSettingsShown");
            });
            self.userSettingsDialog.on('hidden', function() {
                callViewModels(allViewModels, "onUserSettingsHidden");
            });
        }

    }

    OCTOPRINT_VIEWMODELS.push([
        UserSettingsViewModel,
        ["loginStateViewModel", "usersViewModel"],
        ["#usersettings_dialog"]
    ]);
});
