$(function() {
    function SlicingViewModel(parameters) {
        var self = this;

        self.loginState = parameters[0];
        self.printerProfiles = parameters[1];

        self.file = ko.observable(undefined);
        self.target = undefined;
        self.data = undefined;

        self.defaultSlicer = undefined;
        self.defaultProfile = undefined;

        self.destinationFilename = ko.observable();
        self.gcodeFilename = self.destinationFilename; // TODO: for backwards compatiblity, mark deprecated ASAP

        self.title = ko.observable();
        self.slicer = ko.observable();
        self.slicers = ko.observableArray();
        self.profile = ko.observable();
        self.profiles = ko.observableArray();
        self.printerProfile = ko.observable();

        self.colors = ko.observableArray();
        self.selColor = ko.observable();
        self.selDensity = ko.observable("Low");
        self.customDensity = ko.observable();
        self.selResolution = ko.observable("Medium");
        self.platformAdhesion = ko.observable("None");
        self.support = ko.observable("None");
        self.nozzleTypes = ko.observableArray();
        self.selNozzle = ko.observable();
        self.filamentInSpool = ko.observable();
        self.workbenchFile = false; // Signals if the slice dialog was called upon a workbench scene

        self.sliceButtonControl = true;

        self.slicersForFile = function(file) {
            if (file === undefined) {
                return [];
            }

            return _.filter(self.configuredSlicers(), function(slicer) {
                return _.any(slicer.sourceExtensions, function(extension) {
                    return _.endsWith(file.toLowerCase(), "." + extension.toLowerCase());
                });
            });
        };

        self.profilesForSlicer = function(key) {
            if (key == undefined) {
                key = self.slicer();
            }
            if (key == undefined || !self.data.hasOwnProperty(key)) {
                return;
            }
            var slicer = self.data[key];

            var selectedProfile = undefined;
            self.profiles.removeAll();
            _.each(_.values(slicer.profiles), function(profile) {
                var name = profile.displayName;
                if (name == undefined) {
                    name = profile.key;
                }

                if (profile.default) {
                    selectedProfile = profile.key;
                }

                self.profiles.push({
                    key: profile.key,
                    name: name
                })
            });

            self.profile(selectedProfile);
            self.defaultProfile = selectedProfile;
        };

        self.resetProfiles = function() {
            self.profiles.removeAll();
            self.profile(undefined);
        };

        self.configuredSlicers = ko.pureComputed(function() {
            return _.filter(self.slicers(), function(slicer) {
                return slicer.configured;
            });
        });

        self.matchingSlicers = ko.computed(function() {
            var slicers = self.slicersForFile(self.file());

            var containsSlicer = function(key) {
                return _.any(slicers, function(slicer) {
                    return slicer.key == key;
                });
            };

            var current = self.slicer();
            if (!containsSlicer(current)) {
                if (self.defaultSlicer !== undefined && containsSlicer(self.defaultSlicer)) {
                    self.slicer(self.defaultSlicer);
                } else {
                    self.slicer(undefined);
                    self.resetProfiles();
                }
            } else {
                self.profilesForSlicer(self.slicer());
            }

            return slicers;
        });

        self.afterSlicingOptions = [
            {"value": "none", "text": gettext("Do nothing")},
            {"value": "select", "text": gettext("Select for printing")},
            {"value": "print", "text": gettext("Start printing")}
        ];
        self.afterSlicing = ko.observable("none");

        self.show = function(target, file, force, workbench) {
            if (!self.enableSlicingDialog() && !force) {
                return;
            }

            self.requestData(self._nozzleFilamentUpdate);
            self.target = target;
            self.file(file);
            self.title(_.sprintf(gettext("Slicing %(filename)s"), {filename: self.file()}));
            self.destinationFilename(self.file().substr(0, self.file().lastIndexOf(".")));
            self.printerProfile(self.printerProfiles.currentProfile());
            self.afterSlicing("print");

            $("#slicing_configuration_dialog").modal("show");

            // Flag to signal if the slicing window was called by the workbench
            self.workbenchFile = workbench;
        };

        self.slicer.subscribe(function(newValue) {
            if (newValue === undefined) {
                self.resetProfiles();
            } else {
                self.profilesForSlicer(newValue);
            }
        });

        self.enableSlicingDialog = ko.pureComputed(function() {
            return self.configuredSlicers().length > 0;
        });

        self.enableSlicingDialogForFile = function(file) {
            return self.slicersForFile(file).length > 0;
        };

        self.enableSliceButton = ko.pureComputed(function() {
            return self.destinationFilename() != undefined
                && self.destinationFilename().trim() != ""
                && self.slicer() != undefined
                && self.sliceButtonControl == true;
                //&& self.profile() != undefined;
        });

        self.requestData = function(callback) {
            $.ajax({
                url: API_BASEURL + "slicing",
                type: "GET",
                dataType: "json",
                success: function(data) {
                    self.fromResponse(data);
                    if (callback !== undefined) {
                        callback();
                    }
                }
            });
        };

        self.destinationExtension = ko.pureComputed(function() {
            var fallback = "???";
            if (self.slicer() === undefined) {
                return fallback;
            }
            var slicer = self.data[self.slicer()];
            if (slicer === undefined) {
                return fallback;
            }
            var extensions = slicer.extensions;
            if (extensions === undefined) {
                return fallback;
            }
            var destinationExtensions = extensions.destination;
            if (destinationExtensions === undefined || !destinationExtensions.length) {
                return fallback;
            }

            return destinationExtensions[0] || fallback;
        });

        self._nozzleFilamentUpdate = function() {
            $.ajax({
                url: API_BASEURL + "maintenance/get_nozzles_and_filament",
                type: "GET",
                dataType: "json",
                success: function(data) {
                    self.nozzleTypes.removeAll();
                    var nozzleList = data.nozzleList;

                    for (var key in nozzleList) {
                        self.nozzleTypes.push(nozzleList[key].value);
                    }

                    self.selNozzle(data.nozzle);

                    if (data.filament != null) {
                        self.colors().forEach(function(elem) {

                            if (elem == data.filament) {
                                self.selColor(elem);
                            }
                        });
                    } else {
                        // Selects the first color from the list by default
                        if (self.colors().length > 0) {
                            self.selColor(self.colors()[0]);
                        }
                    }

                    self.filamentInSpool(Math.round(data.filamentInSpool))
                }
            });
        };

        self.forPrint = function() {
            if (self.afterSlicing() != "none")
                return true;

            return false;
        };

        self.fromResponse = function(data) {
            self.data = data;

            var selectedSlicer = undefined;
            self.slicers.removeAll();
            _.each(_.values(data), function(slicer) {
                var name = slicer.displayName;
                if (name == undefined) {
                    name = slicer.key;
                }

                if (slicer.default && slicer.configured) {
                    selectedSlicer = slicer.key;
                }

                var props = {
                    key: slicer.key,
                    name: name,
                    configured: slicer.configured,
                    sourceExtensions: slicer.extensions.source,
                    destinationExtensions: slicer.extensions.destination
                };
                self.slicers.push(props);
            });

            self.defaultSlicer = selectedSlicer;
        };

        self.profilesForSlicer = function(key) {
            if (key == undefined) {
                key = self.slicer();
            }
            if (key == undefined || !self.data.hasOwnProperty(key)) {
                return;
            }
            var slicer = self.data[key];

            var selectedProfile = undefined;
            self.profiles.removeAll();
            self.colors.removeAll();

            _.each(_.values(slicer.profiles), function(profile) {
                var name = profile.displayName;
                if (name == undefined) {
                    name = profile.key;
                }

                if (profile.default) {
                    selectedProfile = profile.key;
                }

                self.profiles.push({
                    key: profile.key,
                    name: name
                })

                // Parses the list and filters for BVC colors
                // Assumes the '_' nomenclature separation for the profile names
                var profile_parts = name.split('_');
                if (profile_parts[0] != null) {
                    var color = profile_parts[0].trim();
                    if (!_.findWhere(self.colors(), color)) {
                        self.colors.push(color);
                    }
                }
            });

            if (selectedProfile != undefined) {
                self.profile(selectedProfile);
            }

            self.defaultProfile = selectedProfile;
        };

        self.prepareAndSlice = function() {
            self.sliceButtonControl = false; // Disables the slice button to avoid multiple clicks

            // Checks if the slicing was called on a workbench scene and finally saves it
            if (self.workbenchFile) {
                var saveCall = BEEwb.main.saveScene(self.file());
                // waits for the save operation
                saveCall.done( function () {
                    self.slice(self.file());
                });

            } else {
                self.slice();
            }

        };

        self.slice = function(modelToRemoveAfterSlice) {

            // Selects the slicing profile based on the color and resolution
            if (self.selColor() != null && self.selResolution() != null) {
                var nozzleSizeNorm = self.selNozzle() * 1000;
                var nozzleSizeStr = 'NZ' + nozzleSizeNorm;

                _.each(self.profiles(), function(profile) {
                    // checks if the profile contains the selected color and nozzle size
                    if (_.contains(profile.name, self.selColor())) {

                        if (_.contains(profile.name, self.selResolution())) {

                            if (_.contains(profile.name, nozzleSizeStr)) {
                                self.profile(profile.key);
                            }
                        }
                    }
                });
            }

            var destinationFilename = self._sanitize(self.destinationFilename());

            var destinationExtensions = self.data[self.slicer()] && self.data[self.slicer()].extensions && self.data[self.slicer()].extensions.destination
                                        ? self.data[self.slicer()].extensions.destination
                                        : ["???"];
            if (!_.any(destinationExtensions, function(extension) {
                    return _.endsWith(destinationFilename.toLowerCase(), "." + extension.toLowerCase());
                })) {
                destinationFilename = destinationFilename + "." + destinationExtensions[0];
            }

            var data = {
                command: "slice",
                slicer: self.slicer(),
                profile: self.profile(),
                printerProfile: self.printerProfile(),
                destination: destinationFilename
            };

            if (self.afterSlicing() == "print") {
                data["print"] = true;
            } else if (self.afterSlicing() == "select") {
                data["select"] = true;
            }

            if (modelToRemoveAfterSlice) {
                data["delete_model"] = modelToRemoveAfterSlice;
            }

            // Density support
            if (self.selDensity() == "Low") {
                data['profile.fill_density'] = 5;
            } else if (self.selDensity() == "Medium") {
                data['profile.fill_density'] = 10;
            } else if (self.selDensity() == "High") {
                data['profile.fill_density'] = 20;
            } else if (self.selDensity() == "High+") {
                data['profile.fill_density'] = 40;
            } else if (self.selDensity() == "Custom") {
                if (self.customDensity() > 100)
                    self.customDensity(100);
                if (self.customDensity() < 0)
                    self.customDensity(0);

                data['profile.fill_density'] = self.customDensity();
            }

            // BVC Raft Support
            if (self.platformAdhesion() == 'Raft') {
                data['profile.platform_adhesion'] = 'raft';
            } else if (self.platformAdhesion() == 'Brim') {
                data['profile.platform_adhesion'] = 'brim';
            } else {
                data['profile.platform_adhesion'] = 'none';
            }

            // BVC Support
            if (self.support() == 'Everywhere') {
                data['profile.support'] = 'everywhere';
            } else if (self.platformAdhesion() == 'Touching Platform') {
                data['profile.support'] = 'buildplate';
            } else {
                data['profile.support'] = 'none';
            }

            $.ajax({
                url: API_BASEURL + "files/" + self.target + "/" + self.file(),
                type: "POST",
                dataType: "json",
                contentType: "application/json; charset=UTF-8",
                data: JSON.stringify(data),
                success: function ( response ) {

                    self.sliceButtonControl = true;
                },
                error: function ( response ) {
                    html = _.sprintf(gettext("Could not slice the selected file. Please make sure your printer is connected."));
                    new PNotify({title: gettext("Slicing failed"), text: html, type: "error", hide: false});

                    self.sliceButtonControl = true;
                }
            });

            $("#slicing_configuration_dialog").modal("hide");

            self.destinationFilename(undefined);
            self.slicer(self.defaultSlicer);
            self.profile(self.defaultProfile);
        };

        self._sanitize = function(name) {
            return name.replace(/[^a-zA-Z0-9\-_\.\(\) ]/g, "").replace(/ /g, "_");
        };

        self.onStartup = function() {
            self.requestData();
        };

        self.onEventSettingsUpdated = function(payload) {
            self.requestData();
        };
    }

    OCTOPRINT_VIEWMODELS.push([
        SlicingViewModel,
        ["loginStateViewModel", "printerProfilesViewModel"],
        "#slicing_configuration_dialog"
    ]);
});
